// supabase/functions/generate-ads/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ads-made-simple");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const DAILY_LIMIT = 3;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-email",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function callAnthropic(body, retries = 2) {
  var lastErr = null;
  for (var i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(function(r) { setTimeout(r, 2000 * i); });
    try {
      var res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status === 529 || res.status === 503) {
        console.log("Anthropic returned " + res.status + ", retry " + (i + 1) + "/" + (retries + 1));
        lastErr = new Error("Anthropic " + res.status);
        continue;
      }
      if (!res.ok) {
        var errText = await res.text().catch(function() { return ""; });
        throw new Error("Anthropic " + res.status + ": " + errText.substring(0, 200));
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) continue;
    }
  }
  throw lastErr;
}

serve(async function(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    var body = await req.json();
    var email = body.email;
    var form = body.form;
    var voiceProfile = body.voiceProfile;
    var mode = body.mode;
    var existingVariations = body.existingVariations;
    var regenIdx = body.regenIdx;

    if (!email || !email.includes("@")) {
      return new Response(JSON.stringify({ error: "Valid email required" }), {
        status: 400, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
      });
    }

    var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    var userEmail = email.toLowerCase();

    // Check rate limit (only for full generations)
    if (mode !== "regenerate_one" && mode !== "generate_hooks") {
      var todayStart = new Date(new Date().toISOString().slice(0, 10)).toISOString();
      var logsResult = await supabase.from("generation_log").select("id").eq("email", userEmail).gte("created_at", todayStart);
      var todayCount = (logsResult.data || []).length;
      if (todayCount >= DAILY_LIMIT) {
        return new Response(JSON.stringify({
          error: "You've used all " + DAILY_LIMIT + " generations for today. Come back tomorrow!",
          remaining: 0,
        }), { status: 429, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }) });
      }
    }

    // Build prompt
    var vB = "";
    if (voiceProfile) {
      vB = "\nCRITICAL -- MATCH THIS BRAND VOICE:\nSummary: " + voiceProfile.summary + "\nTraits: " + (voiceProfile.traits || []).join(", ") + "\nSentence style: " + voiceProfile.sentenceStyle + "\nVocabulary: " + voiceProfile.vocabulary + "\nPersonality: " + voiceProfile.personality + "\nAvoids: " + voiceProfile.avoids + "\nThe copy MUST sound like this person wrote it.";
    }

    var cta = form.callToAction === "Custom" ? form.customCta : form.callToAction;

    // Map tone to hook style
    var toneMap = {
      "Warm & Encouraging": "conversational",
      "Professional & Polished": "authoritative",
      "Fun & Playful": "bold",
      "Direct & No-Nonsense": "bold",
      "Empathetic & Supportive": "empathetic",
    };
    var hookTone = toneMap[form.tone] || "conversational";

    var prompt;

    if (mode === "generate_hooks") {
      prompt = "You are an expert direct-response copywriter. Generate 3 scroll-stopping hooks for a Facebook/Instagram ad promoting " + form.leadMagnetName + " (" + form.leadMagnetType + ") to " + form.audienceType + ".\n" + vB + "\n\nEach hook should:\n- Open with a pattern interrupt (unexpected statement, bold claim, or relatable pain point)\n- Be 1 sentence max, under 10 words\n- Avoid generic phrases like \"Are you tired of...\" or \"Introducing...\"\n- Match this tone: " + hookTone + "\n\nFormat each hook with a label for the type (e.g., Pain Point, Curiosity, Shock Stat, Social Proof, Contrarian).\n\nContext about the offer:\n- Business: " + (form.businessName || "a health & wellness professional") + "\n- What it helps with: " + form.whatItHelps + "\n- Audience pain point: " + form.biggestPainPoint + "\n- Desired outcome: " + form.desiredOutcome + "\n- Unique angle: " + (form.uniqueAngle || "None") + "\n\nRespond ONLY with valid JSON (no markdown, no backticks):\n{\"creativeHooks\":[\"[Pain Point] hook text\",\"[Curiosity] hook text\",\"[Contrarian] hook text\"]}";
    } else if (mode === "regenerate_one" && existingVariations) {
      var existing = existingVariations.filter(function(_, i) { return i !== regenIdx; }).map(function(v) { return '"' + v.label + '": ' + v.primaryText.substring(0, 100) + "..."; }).join("\n");
      var labels = ["A", "B", "C"];
      prompt = "You are an elite Facebook ad copywriter. Generate 1 NEW ad variation that takes a DIFFERENT angle from these existing ones:\n" + existing + "\n" + vB + "\n\nSTRICT RULES (violating any of these is a failure):\n- No cliches. BANNED WORDS: game-changer, skyrocket, unlock, next level, stop scrolling, finally, struggling with, imagine if, what if, ready to, transform, revolutionize, secret, hack, crush it, level up, dream, perfect, amazing, incredible\n- No hype language or exaggerated claims\n- No em dashes\n- No fluff or filler sentences\n- No vague benefits. Everything must feel specific and grounded\n- No marketing voice. Write like a real person talking to a friend\n- Every sentence must earn its place. If it does not add new information, cut it\n\nBRIEF:\nBusiness: " + (form.businessName || "a health & wellness professional") + "\nOffer: " + form.leadMagnetName + " (" + form.leadMagnetType + ")\nWhat it helps with: " + form.whatItHelps + "\nAudience: " + form.audienceType + "\nPain point: " + form.biggestPainPoint + "\nDesired outcome: " + form.desiredOutcome + "\nTone: " + form.tone + "\nCTA: " + cta + "\n\nPRIMARY TEXT: 3-5 short paragraphs, hook first, 1-3 emojis max, clear CTA. No em dashes.\nHEADLINE: Under 40 chars. No em dashes.\nDESCRIPTION: Under 90 chars. No em dashes.\n\nRespond ONLY with valid JSON:\n{\"label\":\"Variation " + labels[regenIdx] + ": [2-3 word angle]\",\"primaryText\":\"...\",\"headline\":\"...\",\"description\":\"...\",\"ctaButton\":\"Download|Learn More|Sign Up|Get Offer|Subscribe\",\"score\":{\"hookStrength\":8,\"clarity\":7,\"emotionalPull\":9,\"ctaEffectiveness\":7,\"overall\":8,\"topTip\":\"tip\"}}";
    } else {
      var HOOKS = {
        pain: { name: "Pain Point Opener", template: "Feeling [frustration]? You're not alone." },
        question: { name: "Curiosity Question", template: "What if [desired outcome] was simpler than you think?" },
        myth: { name: "Myth Buster", template: "Stop believing you need [common misconception]." },
        result: { name: "Results-Led", template: "[Specific result]... and here's how." },
        empathy: { name: "Empathy + Solution", template: "I know what it's like to [shared struggle]. That's why I created..." },
      };
      var hook = HOOKS[form.hookFormula];
      var hookI = hook ? '\nHOOK FORMULA TO USE: "' + hook.name + '" -- ' + hook.template + "\nAdapt this formula to the offer. Each variation should use a DIFFERENT interpretation of this hook style." : "\nUse a different hook style for each variation. Try pain point, curiosity, and empathy/results approaches.";

      prompt = "You are an elite Facebook ad copywriter for health & wellness professionals.\n" + vB + "\n\nSTRICT RULES (violating any of these is a failure):\n- No cliches. BANNED WORDS: game-changer, skyrocket, unlock, next level, stop scrolling, finally, struggling with, imagine if, what if, ready to, transform, revolutionize, secret, hack, crush it, level up, dream, perfect, amazing, incredible\n- No hype language or exaggerated claims\n- No em dashes\n- No fluff or filler sentences\n- No vague benefits. Everything must feel specific and grounded\n- No marketing voice. Write like a real person talking to a friend\n- Every sentence must earn its place. If it does not add new information, cut it\n\nBRIEF:\nBusiness: " + (form.businessName || "a health & wellness professional") + "\nOffer: " + form.leadMagnetName + " (" + form.leadMagnetType + ")\nWhat it helps with: " + form.whatItHelps + "\nAudience: " + form.audienceType + "\nPain point: " + form.biggestPainPoint + "\nDesired outcome: " + form.desiredOutcome + "\nTone: " + form.tone + "\nUnique angle: " + (form.uniqueAngle || "None") + "\nCTA: " + cta + "\n" + hookI + "\n\nGenerate 3 DISTINCT ad copy variations AND score each one.\n\nPRIMARY TEXT: 3-5 short paragraphs, hook first, line breaks between paragraphs, 1-3 emojis max, clear CTA at end. Ideal under 500 chars, max 800. No em dashes.\nHEADLINE: Punchy, under 40 chars. No em dashes.\nDESCRIPTION: One line, under 90 chars. No em dashes.\n\nAD CREATIVE HOOKS:\nAlso generate 3 scroll-stopping hooks for the Facebook/Instagram ad image creative. These are short, punchy lines to overlay on the ad graphic.\nEach hook should:\n- Open with a pattern interrupt (unexpected statement, bold claim, or relatable pain point)\n- Be 1 sentence max, under 10 words\n- Avoid generic phrases like \"Are you tired of...\" or \"Introducing...\"\n- Match this tone: " + hookTone + "\n- Be labeled by type (Pain Point, Curiosity, Shock Stat, Social Proof, or Contrarian)\nContext: " + form.leadMagnetName + " (" + form.leadMagnetType + ") for " + form.audienceType + " who want to " + (form.desiredOutcome || form.whatItHelps) + "\n\nRespond ONLY with valid JSON (no markdown, no backticks):\n{\"variations\":[{\"label\":\"Variation A: [2-3 word angle name]\",\"primaryText\":\"...\",\"headline\":\"...\",\"description\":\"...\",\"ctaButton\":\"Download|Learn More|Sign Up|Get Offer|Subscribe\"},{\"label\":\"Variation B: [angle]\",\"primaryText\":\"...\",\"headline\":\"...\",\"description\":\"...\",\"ctaButton\":\"...\"},{\"label\":\"Variation C: [angle]\",\"primaryText\":\"...\",\"headline\":\"...\",\"description\":\"...\",\"ctaButton\":\"...\"}],\"scores\":[{\"hookStrength\":8,\"clarity\":7,\"emotionalPull\":9,\"ctaEffectiveness\":7,\"overall\":8,\"topTip\":\"One specific actionable tip\"},{\"hookStrength\":7,\"clarity\":8,\"emotionalPull\":7,\"ctaEffectiveness\":8,\"overall\":8,\"topTip\":\"...\"},{\"hookStrength\":9,\"clarity\":7,\"emotionalPull\":8,\"ctaEffectiveness\":7,\"overall\":8,\"topTip\":\"...\"}],\"creativeHooks\":[\"[Pain Point] Your hook here\",\"[Curiosity] Your hook here\",\"[Contrarian] Your hook here\"]}";
    }

    var anthropicData = await callAnthropic({
      model: mode === "generate_hooks" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-20250514",
      max_tokens: mode === "generate_hooks" ? 500 : 4000,
      messages: [{ role: "user", content: prompt }],
    });

    var rawText = (anthropicData.content || []).filter(function(c) { return c.type === "text"; }).map(function(c) { return c.text; }).join("").replace(/```json|```/g, "").trim();
    var match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      return new Response(JSON.stringify({ error: "The AI returned something unexpected. Please try again." }), {
        status: 502, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
      });
    }

    var parsed = JSON.parse(match[0]);

    // Log generation (only for full generations)
    if (mode !== "regenerate_one" && mode !== "generate_hooks") {
      await supabase.from("generation_log").insert({ email: userEmail });
    }

    // Save results to session
    if (mode !== "regenerate_one" && mode !== "generate_hooks") {
      await supabase.from("sessions").upsert({
        email: userEmail,
        form_data: form,
        results: parsed,
        current_step: 5,
        updated_at: new Date().toISOString(),
      }, { onConflict: "email" });
    }

    // Calculate remaining
    var todayStart2 = new Date(new Date().toISOString().slice(0, 10)).toISOString();
    var allLogsResult = await supabase.from("generation_log").select("id").eq("email", userEmail).gte("created_at", todayStart2);
    var rem = Math.max(0, DAILY_LIMIT - ((allLogsResult.data || []).length));

    return new Response(JSON.stringify({ results: parsed, remaining: rem }), {
      headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
    });
  } catch (err) {
    console.error("Function error:", err);
    var msg = String(err);
    if (msg.includes("529") || msg.includes("503")) {
      return new Response(JSON.stringify({ error: "The AI is overloaded right now. Try again in 30 seconds!" }), {
        status: 503, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
      });
    }
    if (msg.includes("429")) {
      return new Response(JSON.stringify({ error: "Too many requests to the AI. Wait a minute and try again!" }), {
        status: 429, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
      });
    }
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
    });
  }
});
