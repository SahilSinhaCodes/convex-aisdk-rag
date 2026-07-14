import { groq } from "@ai-sdk/groq";
import { getAuthUserId } from "@convex-dev/auth/server";
import { convertToModelMessages, streamText, tool, UIMessage } from "ai";
import { httpRouter } from "convex/server";
import { z } from "zod";
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

    // Deep clean history so Groq never rejects a turn due to a previous tool error state
    const sanitizedMessages = modelMessages.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call") {
              const hasValidInput =
                part.input &&
                typeof part.input === "object" &&
                Object.keys(part.input).length > 0;
              return {
                ...part,
                input: hasValidInput ? part.input : { query: "" },
              };
            }
            return part;
          }),
        };
      }
      return msg;
    });

    const result = streamText({
      model: groq("llama-3.1-8b-instant"),
      system: `
          You are a helpful assistant that can search through the user's notes.
          Use the information from the notes to answer questions and provide insights.
          If the requested information is not available, respond with "Sorry, I can't find that information in your notes".
          You can use markdown formatting like links, bullet points, numbered lists, and bold text.

          CRITICAL: When providing links to relevant notes, replace "<note-id>" with the actual unique id string returned by the tool execution.
          Use this exact relative URL structure: '/notes?noteId=ACTUAL_ID_HERE'. For example, if the id is "123", the link markdown must look exactly like: [Note Title](/notes?noteId=123).

          Keep your responses concise and to the point.
`,
      messages: sanitizedMessages,
      tools: {
        findRelevantNotes: tool({
          description:
            "Retrieve relevant notes from the database based on the user's query. Only call this when the user is asking about specific note content — not for greetings or general chat.",
          parameters: z.object({
            query: z.string().min(1).describe("The user's search query, must not be empty"),
          }),
          execute: async ({ query }) => {
            if (!query || !query.trim()) {
              console.log("findRelevantNotes called with empty query, skipping");
              return [];
            }
            console.log("findRelevantNotes query:", query);
            const relevantNotes = await ctx.runAction(
              internal.notesActions.findRelevantNotes,
              { query, userId }
            );
            return relevantNotes.map((note) => ({
              id: note._id,
              title: note.title,
              body: note.body,
              creationTime: note._creationTime,
            }));
          },
        }),
      },
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