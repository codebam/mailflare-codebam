import type { SettingsNavSection } from "./settings-nav-types";

export const settingsNavSections: SettingsNavSection[] = [
	{
		labelKey: "settings.nav.settings",
		items: [
			{
				href: "/settings/account",
				labelKey: "settings.nav.account",
			},
			{
				href: "/settings/inbox",
				labelKey: "settings.nav.inbox",
			},
			{
				href: "/settings/security",
				labelKey: "settings.nav.security",
			},
			{
				href: "/settings/api-keys",
				labelKey: "settings.nav.apiKeys",
			},
			{
				href: "/settings/app-passwords",
				labelKey: "settings.nav.appPasswords",
			},
			{
				href: "/settings/rules",
				labelKey: "settings.nav.rules",
			},
		],
	},
	{
		labelKey: "settings.nav.mailbox",
		items: [
			{
				href: "/settings/mailboxes",
				labelKey: "admin.nav.mailboxes",
				requiresMailboxAccess: true,
			},
			{
				href: "/settings/import",
				labelKey: "settings.nav.import",
			},
			{
				href: "/settings/export",
				labelKey: "settings.nav.export",
			},
		],
	},
	{
		labelKey: "settings.nav.automation",
		items: [
			{
				href: "/settings/automation-rules",
				labelKey: "settings.nav.automationRules",
			},
			{
				href: "/settings/templates",
				labelKey: "settings.nav.templates",
			},
			{
				href: "/settings/saved-searches",
				labelKey: "settings.nav.savedSearches",
			},
			{
				href: "/settings/labels",
				labelKey: "settings.nav.labels",
			},
			{
				href: "/settings/categories",
				labelKey: "settings.nav.categories",
			},
			{
				href: "/settings/access-tokens",
				labelKey: "settings.nav.accessTokens",
			},
		],
	},
];

export function isActiveSettingsPath(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}
