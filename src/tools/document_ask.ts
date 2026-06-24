/**
 * document_ask — wraps `client.inference.documentAsk(...)` →
 * `POST /v1/documents/{id}/ask`.
 *
 * Same SSE-aggregation + progress-notifications pattern as rag_ask.
 * See sibling file for full architectural commentary.
 *
 * Differences vs rag_ask:
 *   - Scoped to a single document, not a corpus
 *   - No `search_results` event; emits `document_context` instead
 *   - Returns structured 413 on documents exceeding the 32k-input-token cap
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { consumeStream, type SseEvent } from '../sse.js';
import { toolError } from './errors.js';

const inputSchema = {
  documentId: z.string().min(1, 'documentId is required').describe('ID of the document to ask against.'),
  prompt: z.string().min(1, 'prompt is required').describe('Question to ask about the document.'),
  model: z
    .string()
    .optional()
    .describe(
      'Inference model alias. Default = tier-appropriate Haiku. ' +
        'See GET /v1/models for the catalog the calling key can reach.',
    ),
  maxTokens: z.number().int().min(1).optional().describe('Max output tokens.'),
};

const documentAsk: ToolFactory = ({ client, log }) => ({
  name: 'document_ask',
  title: 'Document ask (single-document)',
  description:
    'Ask a question against a single indexed document. Returns a grounded answer with the document context that informed it. ' +
    'For documents exceeding the input-token cap, the API returns a structured 413 with `estimatedTokens` and `limitTokens`. ' +
    'Inference runs in-perimeter against AWS Bedrock — PHI never leaves the BAA boundary.',
  inputSchema,
  handler: async (args, extra): Promise<ToolResult> => {
    try {
      const stream = (await client.inference.documentAsk({
        id: args.documentId as string,
        prompt: args.prompt as string,
        model: args.model as string | undefined,
        maxTokens: args.maxTokens as number | undefined,
      })) as AsyncIterable<SseEvent>;

      const progressToken = extra._meta?.progressToken;
      const onProgress = progressToken !== undefined && extra.sendNotification
        ? async (chunk: { text: string; total: number }) => {
            await extra.sendNotification!({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: chunk.total,
                message: chunk.text,
              },
            });
          }
        : undefined;

      const aggregated = await consumeStream(stream, onProgress);

      log.debug(
        {
          tool: 'document_ask',
          documentId: args.documentId,
          answerLength: aggregated.answer.length,
          usage: aggregated.usage,
        },
        'document_ask ok',
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                answer: aggregated.answer,
                documentContext: aggregated.documentContext,
                usage: aggregated.usage,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      log.warn({ tool: 'document_ask', err: String(err) }, 'document_ask failed');
      return toolError(
        'document_ask',
        err,
        'https://docs.vectros.ai/feature-inference#known-limitations',
      );
    }
  },
});

export default documentAsk;
