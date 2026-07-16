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


    let queryText = "search";
    const lastUserMessage: any = messages.filter((m) => m.role === "user").pop();

    if (lastUserMessage) {
      if (Array.isArray(lastUserMessage.parts)) {
        const textPart = lastUserMessage.parts.find((p: any) => p.type === "text");
        if (textPart) queryText = textPart.text;
      } else if (typeof lastUserMessage.content === "string") {
        queryText = lastUserMessage.content;
      }
    }

    console.log(`\n🔍 DIRECT PIPELINE SEARCH | Query: "${queryText}"`);


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