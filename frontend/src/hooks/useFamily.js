import { useScope } from '@/hooks/useScope';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { family } from '@/api/family.api';
import { members } from '@/api/members.api';
import { tasks } from '@/api/tasks.api';
import { templates } from '@/api/templates.api';
import { points } from '@/api/points.api';
import { awards } from '@/api/awards.api';
// Non-hook toast dispatcher. It writes to the same module-level store the
// mounted `<Toaster />` listens to, so it can be called from inside a
// mutation callback (which is not a React component) without violating the
// rules of hooks (R22.2).
import { toast } from '@/components/ui/use-toast';

// Data-layer hooks for the Family Task Board.
//
// Every cache, optimistic write and invalidation is bound to the current access scope.

export const useFamily = () => {
  const scope = useScope();
  return useQuery({
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    queryKey: scope.key('family'),
    enabled: scope.enabled,
    queryFn: ({ signal }) => family.get(signal),
  });
};

export const useMembers = (activeOnly = false) => {
  const scope = useScope();
  return useQuery({
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    queryKey: scope.key('members', { activeOnly }),
    enabled: scope.enabled && scope.canManage,
    // The REST module filters the roster server-side via `?active=true`.
    // Pass `undefined` when not filtering so all members are returned.
    queryFn: ({ signal }) =>
      members.list(activeOnly ? true : undefined, signal),
  });
};

export const useTasks = (filters = {}) => {
  const scope = useScope();
  return useQuery({
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    queryKey: scope.key('tasks', filters),
    enabled: scope.enabled,
    queryFn: ({ signal }) => {
      // Map the hook's public filter shape to the REST TaskFilter. The hook
      // keeps `dueDate` for call-site stability; the API expects `date`.
      const filter = {};
      if (filters.weekStart) filter.weekStart = filters.weekStart;
      if (filters.dueDate) filter.date = filters.dueDate;
      if (filters.status) filter.status = filters.status;
      if (filters.memberId) filter.memberId = filters.memberId;
      return tasks.list(filter, signal);
    },
  });
};

export const usePoints = () => {
  const scope = useScope();
  return useQuery({
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    queryKey: scope.key('points'),
    enabled: scope.enabled && scope.canManage,
    queryFn: ({ signal }) => points.list({}, signal),
  });
};

export const useTemplates = () => {
  const scope = useScope();
  return useQuery({
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    queryKey: scope.key('templates'),
    enabled: scope.enabled && scope.canManage,
    queryFn: ({ signal }) => templates.list(signal),
  });
};

export const useCreateFamily = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    // This legacy hook updates the resolved family profile; tenant creation is separate. It maps to a
    // PATCH /family update rather than a dedicated create endpoint.
    mutationFn: (data) => family.update(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useUpdateFamily = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: ({ data }) => family.update(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useSaveMember = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: ({ id, data }) =>
      id ? members.update(id, data) : members.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useDeleteMember = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    // DELETE /family/members/:id is a soft delete (sets active=false).
    mutationFn: (member) => members.remove(member.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useSaveTask = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: ({ id, data }) =>
      id ? tasks.update(id, data) : tasks.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useDeleteTask = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: (id) => tasks.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useMoveTask = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    // Board moves between non-DONE columns go through POST /tasks/:id/move.
    mutationFn: ({ id, data }) => tasks.move(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useCompleteTask = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    // Server owns the awarded points; the response (CompleteTaskPayload) is
    // returned verbatim by tasks.complete so callers can surface the awarded
    // points from the server only (R22.3).
    mutationFn: ({ taskId, completedByMemberId }) =>
      tasks.complete(taskId, { completedByMemberId }),

    // Optimistically flip the task to DONE before the backend responds (R22.1).
    onMutate: async ({ taskId }) => {
      // Stop in-flight refetches so they can't clobber the optimistic write.
      await qc.cancelQueries({ queryKey: scope.key('tasks') });

      // There are many ['tasks'] caches (one per filter key, e.g.
      // ['tasks', { weekStart }] / ['tasks', { dueDate }]). Snapshot every one
      // so onError can restore each exactly (R22.1).
      const previousTasks = qc.getQueriesData({ queryKey: scope.key('tasks') });

      // Optimistically set the matching task's status to DONE across every
      // ['tasks'] cache. We only touch `status` — awarded points are NOT
      // applied optimistically; they come from the server response (R22.3).
      qc.setQueriesData({ queryKey: scope.key('tasks') }, (list) => {
        if (!Array.isArray(list)) return list;
        return list.map((task) =>
          task?.id === taskId ? { ...task, status: 'DONE' } : task,
        );
      });

      // Hand the snapshot to onError via mutation context.
      return { previousTasks };
    },

    // Roll back every snapshotted cache and surface the failure (R22.2).
    onError: (err, _vars, context) => {
      if (context?.previousTasks) {
        for (const [queryKey, data] of context.previousTasks) {
          if (qc.getQueryCache().find({ queryKey, exact: true }))
            qc.setQueryData(queryKey, data);
        }
      }
      toast({
        title: 'Could not complete the task',
        description: err?.message || 'Please try again.',
        variant: 'destructive',
      });
    },

    // Reconcile with the server once settled: refetch tasks and the points
    // ledger so the confirmed status and awarded points are authoritative.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: scope.prefix });
    },
  });
};

export const useReopenTask = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: ({ taskId }) => tasks.reopen(taskId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scope.prefix });
    },
  });
};

export const useGenerateRecurring = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: ({ weekStart }) => templates.generate({ weekStart }),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useSaveTemplate = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: ({ id, data }) =>
      id ? templates.update(id, data) : templates.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useDeleteTemplate = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: (id) => templates.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useCompletions = (memberId) => {
  const scope = useScope();
  return useQuery({
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    queryKey: scope.key('completions', memberId),
    // GET /family/members/:id/completions returns { completions, transactions }.
    // Callers (MemberProfile) consume the completions array directly, so unwrap
    // to that array to keep the hook's public contract stable.
    queryFn: async ({ signal }) => {
      const res = await points.memberCompletions(memberId, signal);
      return res.completions;
    },
    enabled:
      scope.enabled &&
      !!memberId &&
      (scope.canManage || scope.memberId === memberId),
  });
};

export const useAwards = () => {
  const scope = useScope();
  return useQuery({
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    queryKey: scope.key('awards'),
    enabled: scope.enabled,
    queryFn: ({ signal }) => awards.list(signal),
  });
};

export const useSaveAward = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: ({ id, data }) =>
      id ? awards.update(id, data) : awards.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};

export const useDeleteAward = () => {
  const qc = useQueryClient();
  const scope = useScope();
  return useMutation({
    mutationFn: (id) => awards.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
};
