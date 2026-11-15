import type { SenderPolicy } from "./sender-policy-utils";

export type SenderPolicyEntry = {
	address: string;
	policy: SenderPolicy;
	createdAt: string;
};