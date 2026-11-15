export type MailboxTemplate = {
	id: string;
	name: string;
	subject: string;
	body: string;
	createdAt: string;
	updatedAt: string;
};

export type TemplateError = "not_found" | "invalid_name" | "invalid_subject" | "invalid_body" | "limit_reached";

export type TemplateResult = { ok: true; template: MailboxTemplate } | { ok: false; error: TemplateError };