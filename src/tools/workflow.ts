import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CardCreate, CardPatch } from '@verevoir/workflows';
import { pickWorkflowAdapter, resolveWorkflowEnv } from '../router.js';

export function registerWorkflowTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // list_columns
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_columns',
    {
      description:
        'List the columns (workflow states) of a kanban board or Notion work-tracker database. Returns Column[] ordered by position.',
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
      },
    },
    async ({ boardUrl }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      const result = await adapter.listColumns(env, boardUrl);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // list_cards
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_cards',
    {
      description:
        "List cards/rows on a kanban board or Notion work-tracker database, with optional filters by column, assignee, label, or parent card. This is how you read the project's work tracker — prefer it over hunting for a task list in local files. Returns Card[].",
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
        columnId: z.string().optional().describe('Restrict to cards in this column.'),
        assigneeId: z.string().optional().describe('Restrict to cards assigned to this user.'),
        labelId: z.string().optional().describe('Restrict to cards carrying this label.'),
        parentId: z.string().optional().describe('Restrict to direct children of this card.'),
      },
    },
    async ({ boardUrl, columnId, assigneeId, labelId, parentId }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      const filter = { columnId, assigneeId, labelId, parentId };
      const result = await adapter.listCards(env, boardUrl, filter);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // get_card
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_card',
    {
      description: 'Fetch a single card by ID. Throws 404 if the card does not exist.',
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
        cardId: z.string().describe('Card ID.'),
      },
    },
    async ({ boardUrl, cardId }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      const result = await adapter.getCard(env, boardUrl, cardId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // create_card
  // -------------------------------------------------------------------------
  server.registerTool(
    'create_card',
    {
      description: 'Create a new card in a column. Returns the created Card.',
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
        columnId: z.string().describe('Column to create the card in.'),
        title: z.string().describe('Card title.'),
        body: z.string().optional().describe('Card description in Markdown.'),
        labelIds: z.array(z.string()).optional().describe('Label IDs to attach.'),
        dueDate: z.string().optional().describe('Due date in ISO8601 format.'),
      },
    },
    async ({ boardUrl, columnId, title, body, labelIds, dueDate }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      const fields: CardCreate = { title, body, labelIds, dueDate };
      const result = await adapter.createCard(env, boardUrl, columnId, fields);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // update_card
  // -------------------------------------------------------------------------
  server.registerTool(
    'update_card',
    {
      description:
        'Apply a partial update to a card. Only supplied fields are changed; omitted fields are left as-is.',
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
        cardId: z.string().describe('Card ID to update.'),
        title: z.string().optional().describe('New title.'),
        body: z
          .string()
          .optional()
          .describe(
            'New card body in Markdown. Replaces the entire body — on Notion this re-parses the Markdown and archives any nested child pages, so pass the full intended body, not a fragment.'
          ),
        columnId: z.string().optional().describe('Move card to this column.'),
        labelIds: z
          .array(z.string())
          .optional()
          .describe("Replace the card's label set with these IDs."),
        dueDate: z.string().optional().describe('Due date in ISO8601 format.'),
      },
    },
    async ({ boardUrl, cardId, title, body, columnId, labelIds, dueDate }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      const patch: CardPatch = { title, body, columnId, labelIds, dueDate };
      await adapter.updateCard(env, boardUrl, cardId, patch);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // move_card
  // -------------------------------------------------------------------------
  server.registerTool(
    'move_card',
    {
      description:
        'Move a card to a different column. Shorthand for update_card with only columnId.',
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
        cardId: z.string().describe('Card ID to move.'),
        toColumnId: z.string().describe('Destination column ID.'),
      },
    },
    async ({ boardUrl, cardId, toColumnId }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      await adapter.moveCard(env, boardUrl, cardId, toColumnId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // list_comments
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_comments',
    {
      description:
        'List comments on a card, most-recent-first. Returns Comment[] with body, authorName, and date.',
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
        cardId: z.string().describe('Card ID.'),
      },
    },
    async ({ boardUrl, cardId }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      const result = await adapter.listComments(env, boardUrl, cardId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // add_comment
  // -------------------------------------------------------------------------
  server.registerTool(
    'add_comment',
    {
      description: 'Add a comment to a card.',
      inputSchema: {
        boardUrl: z
          .string()
          .describe(
            'Trello board URL (https://trello.com/b/<id>) or Notion database URL (https://www.notion.so/<db-id>).'
          ),
        cardId: z.string().describe('Card ID to comment on.'),
        body: z.string().describe('Comment body in Markdown.'),
      },
    },
    async ({ boardUrl, cardId, body }) => {
      const adapter = await pickWorkflowAdapter(boardUrl);
      const env = resolveWorkflowEnv(boardUrl);
      await adapter.addComment(env, boardUrl, cardId, body);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      };
    }
  );
}
