import { annotate } from "@crustjs/skills";
import { app } from "../app.ts";
import {
	normalizeUsageSummary,
	printCliUsage,
} from "../services/compat/usage.ts";
import { createCliSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";

export const usageCommand = annotate(
	app
		.sub("usage")
		.meta({ description: "View API usage summary" })
		.run(async ({ flags }) => {
			await withErrorHandling({ domain: "Usage" }, async () => {
				const cliSdk = await createCliSdk({ apiKey: flags["api-key"] });
				const result = await cliSdk.usage.getSummary();
				printCliUsage(normalizeUsageSummary(result));
			});
		}),
	[
		"Check API usage, plan limits, and billing period.",
		"Shows breakdown of all operation types with used/limit counts.",
	],
);
