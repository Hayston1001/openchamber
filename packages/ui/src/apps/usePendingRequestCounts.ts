import React from 'react';

import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';

export type PendingRequestCounts = { permissionCount: number; questionCount: number };

/**
 * Waiting permission and question requests for a row. Counts come from the
 * cross-directory request index, so a project the phone never opened still
 * shows them. `sessionIds` is the row's own session plus any subsessions it
 * hides: a subagent's request blocks the whole family. A question count sums
 * the fields of every pending form, so one multi-question request shows as the
 * several questions it is.
 */
export const usePendingRequestCounts = (sessionIds: readonly string[]): PendingRequestCounts => {
  const permissionCount = useGlobalBlockingRequestsStore(React.useCallback((state) => {
    let count = 0;
    for (const id of sessionIds) count += state.bySession.get(id)?.permissions.length ?? 0;
    return count;
  }, [sessionIds]));
  const questionCount = useGlobalBlockingRequestsStore(React.useCallback((state) => {
    let count = 0;
    for (const id of sessionIds) {
      for (const form of state.bySession.get(id)?.forms ?? []) count += form.questionCount;
    }
    return count;
  }, [sessionIds]));
  return { permissionCount, questionCount };
};
