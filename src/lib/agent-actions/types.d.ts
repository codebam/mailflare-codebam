export type ActionState = {
	folderId?: string | null;
	read?: boolean;
	starred?: boolean;
};

export type AgentAction = {
	id: string;
	tool: string;
	messageId: string | null;
	subject: string | null;
	threadKey: string | null;
	beforeState: ActionState | null;
	afterState: ActionState | null;
	undoable: boolean;
	undoneAt: string | null;
	createdAt: string;
};

export type UndoError = "not_found" | "not_undoable" | "already_undone" | "message_gone";

export type UndoResult = { ok: true; action: AgentAction } | { ok: false; error: UndoError };