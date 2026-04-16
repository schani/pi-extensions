import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type PullRequest = {
	title?: string;
	url?: string;
};

const SIDE_MARGIN = 1;
const GITHUB_ICON = "";

async function getCurrentPullRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<PullRequest | undefined> {
	try {
		const result = await pi.exec("gh", ["pr", "view", "--json", "title,url"], {
			signal: ctx.signal,
			timeout: 5000,
		});
		if (result.code !== 0 || !result.stdout) return undefined;

		const pr = JSON.parse(result.stdout) as PullRequest;
		if (!pr.url?.trim()) return undefined;
		return pr;
	} catch {
		return undefined;
	}
}

function renderPrWidget(pr: PullRequest) {
	const titleText = pr.title?.trim() || "Untitled PR";
	const urlText = pr.url?.trim() || "";

	return (_tui: unknown, theme: { bold: (text: string) => string; fg: (color: string, text: string) => string }) => ({
		render(width: number): string[] {
			const innerWidth = Math.max(width - SIDE_MARGIN * 2, 0);
			if (innerWidth <= 0) return [""];

			const icon = theme.fg("accent", GITHUB_ICON);
			const separator = theme.fg("muted", " | ");
			const title = theme.fg("mdLink", theme.bold(titleText));
			const link = theme.fg("mdLinkUrl", urlText);
			const prefix = `${icon} ${separator}`;
			const singleLine = `${prefix}${title}${separator}${link}`;

			if (visibleWidth(singleLine) <= innerWidth) {
				return [` ${singleLine} `];
			}

			const titleLine = ` ${truncateToWidth(`${prefix}${title}`, innerWidth)} `;
			const linkIndent = " ".repeat(visibleWidth(prefix));
			const linkWidth = Math.max(innerWidth - visibleWidth(prefix), 0);
			const linkLine = ` ${linkIndent}${truncateToWidth(link, linkWidth)} `;
			return [titleLine, linkLine];
		},
		invalidate(): void {},
	});
}

async function refreshWidget(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const pr = await getCurrentPullRequest(pi, ctx);
	if (!pr) {
		ctx.ui.setWidget("current-pr", undefined);
		return;
	}

	ctx.ui.setWidget("current-pr", renderPrWidget(pr));
}

export default function currentPrWidgetExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await refreshWidget(pi, ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await refreshWidget(pi, ctx);
	});
}
