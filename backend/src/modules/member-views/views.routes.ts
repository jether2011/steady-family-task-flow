import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireFamilyContext } from '../../middleware/context.js';
import { Forbidden } from '../../shared/errors/index.js';
import { historyPage, readView } from './views.service.js';
import {
  CompletionFilter,
  CompletionsPage,
  HistoryFilter,
  PersonalDashboard,
  PointsPage,
  SafeMember,
  SelfMember,
  Summary,
  SummaryFilter,
} from './views.schemas.js';
const Empty = z.object({}).strict(),
  Params = z.object({ id: z.uuid() }).strict();
export function memberViewRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    '/family/member-dashboard',
    { schema: { querystring: Empty, response: { 200: PersonalDashboard } } },
    async (req) => {
      const ctx = requireFamilyContext(req);
      if (!ctx.memberId) throw new Forbidden('A bound participant is required');
      return PersonalDashboard.parse(await readView(ctx, 'dashboard'));
    },
  );
  api.get(
    '/family/member-directory',
    {
      schema: {
        querystring: Empty,
        response: { 200: z.object({ members: z.array(SafeMember) }) },
      },
    },
    async (req) =>
      z
        .object({ members: z.array(SafeMember) })
        .parse(await readView(requireFamilyContext(req), 'directory')),
  );
  api.get(
    '/family/members/:id/profile',
    {
      schema: {
        params: Params,
        querystring: Empty,
        response: {
          200: z.object({ member: SelfMember, balance: z.number() }),
        },
      },
    },
    async (req) =>
      z.object({ member: SelfMember, balance: z.number() }).parse(
        await readView(requireFamilyContext(req), 'profile', {
          memberId: req.params.id,
        }),
      ),
  );
  api.get(
    '/family/points/summary',
    { schema: { querystring: SummaryFilter, response: { 200: Summary } } },
    async (req) =>
      Summary.parse(
        await readView(requireFamilyContext(req), 'summary', req.query),
      ),
  );
  api.get(
    '/family/points',
    { schema: { querystring: HistoryFilter, response: { 200: PointsPage } } },
    async (req) =>
      PointsPage.parse(
        await historyPage(requireFamilyContext(req), 'points', req.query),
      ),
  );
  api.get(
    '/family/members/:id/completions',
    {
      schema: {
        params: Params,
        querystring: CompletionFilter,
        response: { 200: CompletionsPage },
      },
    },
    async (req) =>
      CompletionsPage.parse(
        await historyPage(requireFamilyContext(req), 'completions', {
          ...req.query,
          memberId: req.params.id,
        }),
      ),
  );
}
