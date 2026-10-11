import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { usePendingRequestCounts, type PendingRequestCounts } from './usePendingRequestCounts';

const FAMILY = ['parent', 'child'] as const;

describe('usePendingRequestCounts', () => {
  test('counts the whole family, ignores other sessions, and clears on reply', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    type CountsCapture = { renders: number; counts: PendingRequestCounts | null };
    const capture: CountsCapture = { renders: 0, counts: null };
    const Harness = () => {
      capture.renders += 1;
      capture.counts = usePendingRequestCounts(FAMILY);
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      expect(capture.counts).toEqual({ permissionCount: 0, questionCount: 0 });

      // A request in an unrelated session neither counts nor re-renders the row.
      const idleRenders = capture.renders;
      await act(async () => applyGlobalBlockingRequestEvents('/other', [{
        type: 'permission.asked', properties: { id: 'p-other', sessionID: 'unrelated', action: 'bash', resources: [] },
      }]));
      expect(capture.renders).toBe(idleRenders);

      // A subagent's permission and the parent's question both land on the row.
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        { type: 'permission.asked', properties: { id: 'p1', sessionID: 'child', action: 'bash', resources: [] } },
        { type: 'form.created', properties: { form: { id: 'q1', sessionID: 'parent', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] } } },
      ]));
      expect(capture.counts).toEqual({ permissionCount: 1, questionCount: 1 });

      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        { type: 'permission.replied', properties: { sessionID: 'child', requestID: 'p1' } },
        { type: 'form.settled', properties: { sessionID: 'parent', formID: 'q1' } },
      ]));
      expect(capture.counts).toEqual({ permissionCount: 0, questionCount: 0 });
    } finally {
      await act(async () => root.unmount());
      resetGlobalBlockingRequests();
      dom.restore();
    }
  });

  test('sums the questions a single multi-question form asks', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    let counts: PendingRequestCounts | null = null;
    const Harness = () => {
      counts = usePendingRequestCounts(FAMILY);
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(Harness)));
      // One `question` tool call with three questions arrives as one form with
      // three fields, so the row badge reads three, not one.
      await act(async () => applyGlobalBlockingRequestEvents('/workspace', [
        {
          type: 'form.created',
          properties: {
            form: {
              id: 'q-many',
              sessionID: 'parent',
              title: 'Questions',
              fields: [
                { key: 'q0', type: 'string' },
                { key: 'q1', type: 'string' },
                { key: 'q2', type: 'string' },
              ],
            },
          },
        },
      ]));
      expect(counts).toEqual({ permissionCount: 0, questionCount: 3 });
    } finally {
      await act(async () => root.unmount());
      resetGlobalBlockingRequests();
      dom.restore();
    }
  });
});
