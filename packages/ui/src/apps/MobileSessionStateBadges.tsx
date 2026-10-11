import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import type { PendingRequestCounts } from './usePendingRequestCounts';

/** The goal glyph the desktop sidebar shows, tinted by the goal's status. */
export const MobileSessionGoalGlyph: React.FC<{ session: Session }> = ({ session }) => {
  const { t } = useI18n();
  const goal = getSessionGoal(session);
  if (!goal) return null;
  // SAFETY: sessionGoalStatusLabelKey contains an i18n key for every SessionGoalStatus.
  const label = t(sessionGoalStatusLabelKey[goal.status] as never);
  return (
    <Icon
      name="target"
      className="size-3.5 shrink-0"
      style={{ color: sessionGoalStatusColor[goal.status] }}
      aria-label={label}
    />
  );
};

/** The permission and question badges the desktop sidebar shows. */
export const MobileSessionPendingBadges: React.FC<PendingRequestCounts> = ({ permissionCount, questionCount }) => {
  const { t } = useI18n();
  if (permissionCount === 0 && questionCount === 0) return null;
  const questionLabel = questionCount === 1
    ? t('sessions.sidebar.session.status.questionPendingSingle')
    : t('sessions.sidebar.session.status.questionPendingMany', { count: questionCount });
  return (
    <>
      {permissionCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive"
          aria-label={t('sessions.sidebar.session.status.permissionRequired')}
        >
          <Icon name="shield" className="size-3" />
          <span className="leading-none tabular-nums">{permissionCount}</span>
        </span>
      ) : null}
      {questionCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded bg-status-info/10 px-1 py-0.5 text-[0.7rem] text-status-info"
          aria-label={questionLabel}
        >
          <Icon name="question" className="size-3" />
          <span className="leading-none tabular-nums">{questionCount}</span>
        </span>
      ) : null}
    </>
  );
};
