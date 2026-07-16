import { groq } from "@ai-sdk/groq";
import { getAuthUserId } from "@convex-dev/auth/server";
import { convertToModelMessages, streamText, UIMessage } from "ai";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

http.route({
  path: "/api/chat",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { messages }: { messages: UIMessage[] } = await req.json();
    const lastMessages = messages.slice(-10);
    const modelMessages = convertToModelMessages(lastMessages);

    // 1. DIRECT EXTRACTION: Grab what the user just typed
    let queryText = "search";
    const lastUserMessage = messages.filter((m) => m.role === "user").pop();

    if (lastUserMessage) {
      if (Array.isArray(lastUserMessage.parts)) {
        const textPart = lastUserMessage.parts.find((p: any) => p.type === "text");
        if (textPart) queryText = textPart.text;
      } else if (typeof lastUserMessage.content === "string") {
        queryText = lastUserMessage.content;
      }
    }

    console.log(`\n🔍 DIRECT PIPELINE SEARCH | Query: "${queryText}"`);

    // 2. PRE-RETRIEVAL: Search the database BEFORE calling the LLM
    let notesContext = "No relevant notes found.";
    try {
      const relevantNotes = await ctx.runAction(
        internal.notesActions.findRelevantNotes,
        { query: queryText, userId }
      );
      console.log(`✅ FOUND ${relevantNotes.length} NOTES`);

      if (relevantNotes.length > 0) {
        notesContext = relevantNotes
          .map((n) => `Title: ${n.title}\nContent: ${n.body}`)
          .join("\n\n---\n\n");
      }
    } catch (err) {
      console.error("❌ VECTOR LOOKUP CRASHED:", err);
      notesContext = "Error: Could not search database.";
    }

    // 3. ONE-SHOT STREAM: Feed the database results directly into the System Prompt
    const result = streamText({
      model: groq("openai/gpt-oss-120b"),
      system: `
          You are a helpful assistant that summarizes and answers questions based on the user's saved notes.

          CRITICAL RULES:
          1. Base your answer ONLY on the "RETRIEVED NOTES" below.
          2. If the answer is not in the notes, say "Sorry, I can't find that information in your notes".
          3. Keep your responses concise and to the point.

          --- RETRIEVED NOTES ---
          ${notesContext}
          -----------------------
      `,
      messages: modelMessages,
      // NO TOOLS! We bypass the Vercel/Groq array serialization crash entirely.
      onError(error) {
        console.error("streamText error:", error);
      },
    });

    return result.toUIMessageStreamResponse({
      headers: new Headers({
        "Access-Control-Allow-Origin": "*",
        Vary: "origin",
      }),
    });
  }),
});

http.route({
  path: "/api/chat",
  method: "OPTIONS",
  handler: httpAction(async (_, request) => {
    const headers = request.headers;
    if (
      headers.get("Origin") !== null &&
      headers.get("Access-Control-Request-Method") !== null &&
      headers.get("Access-Control-Request-Headers") !== null
    ) {
      return new Response(null, {
        headers: new Headers({
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, Digest, Authorization",
          "Access-Control-Max-Age": "86400",
        }),
      });
    } else {
      return new Response();
    }
  }),
});

export default http;