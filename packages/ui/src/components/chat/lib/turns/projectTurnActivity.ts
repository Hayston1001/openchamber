import { isQuestionTool, normalizeToolName, type ToolName } from '@/lib/opencode/tools';
import { ACTIVITY_STANDALONE_TOOL_NAMES } from './constants';
import type {
    ChatMessageEntry,
    TurnActivityGroup,
    TurnActivityRecord,
    TurnPartRecord,
} from './types';

const isStandaloneTool = (toolName: ToolName): boolean => {
    return ACTIVITY_STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

const getPartEndTime = (part: unknown): number | undefined => {
    const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end;
    if (typeof stateEnd === 'number') {
        return stateEnd;
    }
    const timeEnd = (part as { time?: { end?: unknown } }).time?.end;
    return typeof timeEnd === 'number' ? timeEnd : undefined;
};

const getPartText = (part: unknown): string | undefined => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length > 0) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) {
        return content;
    }
    return undefined;
};

const getMessageFinish = (message: ChatMessageEntry): string | undefined => {
    const finish = (message.info as { finish?: unknown }).finish;
    return typeof finish === 'string' ? finish : undefined;
};

const buildTurnPartRecord = (
    turnId: string,
    messageId: string,
    part: ChatMessageEntry['parts'][number],
    partIndex: number,
): TurnPartRecord => {
    return {
        id: part.id ?? `${messageId}-part-${partIndex}-${part.type}`,
        turnId,
        messageId,
        part,
        partIndex,
        endedAt: getPartEndTime(part),
    };
};

interface ProjectActivityInput {
    turnId: string;
    assistantMessages: ChatMessageEntry[];
    summarySourceMessageId?: string;
    summarySourcePartId?: string;
    showTextJustificationActivity: boolean;
    /**
     * When true, the model's intermediate text (Justification) is a segment
     * boundary: it splits Activity around itself and renders as visible text
     * outside every group. Off keeps it inside the current group.
     */
    justificationOutsideActivity: boolean;
}

interface ProjectActivityResult {
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    hasTools: boolean;
    hasReasoning: boolean;
}

export const projectTurnActivity = (input: ProjectActivityInput): ProjectActivityResult => {
    const activityParts: TurnActivityRecord[] = [];
    let hasTools = false;
    let hasReasoning = false;

    input.assistantMessages.forEach((message) => {
        message.parts.forEach((part) => {
            if (part.type === 'tool') {
                hasTools = true;
                return;
            }

            if (part.type === 'reasoning' && getPartText(part)) {
                hasReasoning = true;
            }
        });
    });

    // A segment anchor is any row that splits Activity without being part of a
    // segment itself: a standalone tool (subagent) or, when the setting asks
    // for it, the intermediate text (Justification). Anchors are recorded in
    // encounter order so segments come out chronologically.
    const anchorMessageById = new Map<string, string>();
    const anchorOrder: string[] = [];
    const partsByAfterAnchor = new Map<string | null, TurnActivityRecord[]>();
    let currentAnchorPartId: string | null = null;

    const registerAnchor = (partId: string, messageId: string) => {
        if (!anchorMessageById.has(partId)) {
            anchorMessageById.set(partId, messageId);
            anchorOrder.push(partId);
        }
        currentAnchorPartId = partId;
    };

    input.assistantMessages.forEach((message) => {
        const finish = getMessageFinish(message);
        const messageHasTool = message.parts.some((part) => part.type === 'tool');
        // A turn blocked on a question never reaches finish === 'stop' (the
        // user must answer first). Treating the text the model produced
        // before the question as 'justification' would bury it inside the
        // collapsible Activity group — the context stays invisible until the
        // turn completes (OPE-199). Keep it inline like OpenCode.
        const messageHasQuestion = message.parts.some((part) => (
            part.type === 'tool' && isQuestionTool(part.tool)
        ));

        message.parts.forEach((part, partIndex) => {
            const isTool = part.type === 'tool';

            const text = part.type === 'reasoning' || part.type === 'text'
                ? getPartText(part)
                : undefined;
            const partId = part.id ?? `${message.info.id}-part-${partIndex}-${part.type}`;

            // SAFETY: a tool part always carries a string `tool` name; this
            // view only reads it and tolerates its absence.
            const toolName = isTool ? (part as { tool?: string }).tool : undefined;
            const standaloneTool = isTool && isStandaloneTool(toolName);
            if (standaloneTool) {
                registerAnchor(partId, message.info.id);
            }

            const isConfirmedSummaryText = part.type === 'text'
                && typeof text === 'string'
                && finish === 'stop'
                && input.summarySourceMessageId === message.info.id
                && input.summarySourcePartId === partId;

            let kind: TurnActivityRecord['kind'] | null = null;
            if (isTool) {
                kind = 'tool';
            } else if (part.type === 'reasoning') {
                if (text) {
                    kind = 'reasoning';
                }
            } else if (
                input.showTextJustificationActivity
                && part.type === 'text'
                && text
                && !messageHasQuestion
                && !isConfirmedSummaryText
                && (messageHasTool || (typeof finish === 'string' && finish !== 'stop'))
            ) {
                kind = 'justification';
            }

            if (!kind) {
                return;
            }

            if (kind === 'justification' && input.justificationOutsideActivity) {
                registerAnchor(partId, message.info.id);
            }

            const activity: TurnActivityRecord = {
                ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                kind,
            };
            activityParts.push(activity);

            // Anchor rows split Activity but are rendered outside every group.
            const isAnchorRow = (kind === 'tool' && standaloneTool)
                || (kind === 'justification' && input.justificationOutsideActivity);
            if (isAnchorRow) {
                return;
            }

            const list = partsByAfterAnchor.get(currentAnchorPartId) ?? [];
            list.push(activity);
            partsByAfterAnchor.set(currentAnchorPartId, list);
        });
    });

    const activitySegments: TurnActivityGroup[] = [];

    const pickStartAnchor = (segmentParts: TurnActivityRecord[]): string | undefined => {
        if (segmentParts.length === 0) {
            return undefined;
        }

        const countByMessage = new Map<string, number>();
        segmentParts.forEach((activity) => {
            countByMessage.set(activity.messageId, (countByMessage.get(activity.messageId) ?? 0) + 1);
        });

        let firstWithAny: string | undefined;
        for (const message of input.assistantMessages) {
            const count = countByMessage.get(message.info.id) ?? 0;
            if (count > 0 && !firstWithAny) {
                firstWithAny = message.info.id;
            }
        }

        return firstWithAny;
    };

    const orderedKeys: Array<string | null> = [null, ...anchorOrder];
    orderedKeys.forEach((afterAnchorPartId) => {
        const segmentParts = partsByAfterAnchor.get(afterAnchorPartId) ?? [];
        if (segmentParts.length === 0) {
            return;
        }

        const anchorMessageId = afterAnchorPartId === null
            ? pickStartAnchor(segmentParts)
            : anchorMessageById.get(afterAnchorPartId);

        if (!anchorMessageId) {
            return;
        }

        activitySegments.push({
            id: `${input.turnId}:${anchorMessageId}:${afterAnchorPartId ?? 'start'}`,
            anchorMessageId,
            afterToolPartId: afterAnchorPartId,
            parts: segmentParts,
        });
    });

    return {
        activityParts,
        activitySegments,
        hasTools,
        hasReasoning,
    };
};
