"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { generateEmbedding, generateEmbeddings } from "../src/lib/embeddings";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { action, internalAction } from "./_generated/server";

export const createNote = action({
  args: {
    title: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("User must be authenticated to create a note");
    }

    const text = `${args.title}\n\n${args.body}`;
    const embeddings = await generateEmbeddings(text);

    const noteId: Id<"notes"> = await ctx.runMutation(
      internal.notes.createNoteWithEmbeddings,
      {
        title: args.title,
        body: args.body,
        userId,
        embeddings,
      }
    );

    return noteId;
  },
});

export const findRelevantNotes = internalAction({
  args: {
    query: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<Array<Doc<"notes">>> => {
    const embedding = await generateEmbedding(args.query);

    // Vector searches are strictly action context utilities
    const results = await ctx.vectorSearch("noteEmbeddings", "by_embedding", {
      vector: embedding,
      limit: 16,
      filter: (q) => q.eq("userId", args.userId),
    });

    const embeddingIds = results.map((result) => result._id);

    // Offload database object hydration to internal queries
    const notes = await ctx.runQuery(internal.notes.fetchNotesByEmbeddingIds, {
      embeddingIds,
    });

    return notes;
  },
});