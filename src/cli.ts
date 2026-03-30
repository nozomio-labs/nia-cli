import {
	autoCompletePlugin,
	helpPlugin,
	type UpdateNotifierCacheAdapter,
	updateNotifierPlugin,
	versionPlugin,
} from "@crustjs/plugins";
import { skillPlugin } from "@crustjs/skills";
import { createStore, stateDir } from "@crustjs/store";
import pkg from "../package.json";
import { app } from "./app.ts";
import { authCommand } from "./commands/auth";
import { categoriesCommand } from "./commands/categories";
import { connectorsCommand } from "./commands/connectors";
import { contextsCommand } from "./commands/contexts";
import { datasetsCommand } from "./commands/datasets";
import { depsCommand } from "./commands/deps";
import { documentCommand } from "./commands/document";
import { extractCommand } from "./commands/extract";
import { gdriveCommand } from "./commands/gdrive";
import { githubCommand } from "./commands/github";
import { localCommand } from "./commands/local";
import { oracleCommand } from "./commands/oracle";
import { packagesCommand } from "./commands/packages";
import { papersCommand } from "./commands/papers";
import { reposCommand } from "./commands/repos";
import { searchCommand } from "./commands/search";
import { slackCommand } from "./commands/slack";
import { sourcesCommand } from "./commands/sources";
import { tracerCommand } from "./commands/tracer";
import { usageCommand } from "./commands/usage";
import { xCommand } from "./commands/x-integration";
import { experimentalModePlugin } from "./plugins/experimental.ts";
import { APP_NAME } from "./services/config.ts";

const updateStore = createStore({
	dirPath: stateDir(APP_NAME),
	name: "update-notifier",
	fields: {
		lastCheckedAt: { type: "number", default: 0 },
		latestVersion: { type: "string" },
		lastNotifiedVersion: { type: "string" },
	},
});

const cacheAdaptor: UpdateNotifierCacheAdapter = {
	read: async () => updateStore.read(),
	write: async (state) =>
		updateStore.write({
			lastCheckedAt: state.lastCheckedAt,
			lastNotifiedVersion: state.lastNotifiedVersion,
			latestVersion: state.latestVersion,
		}),
};

const main = app
	.command(authCommand)
	.command(searchCommand)
	.command(reposCommand)
	.command(sourcesCommand)
	.command(oracleCommand)
	.command(tracerCommand)
	.command(contextsCommand)
	.command(packagesCommand)
	.command(githubCommand)
	.command(localCommand)
	.command(papersCommand)
	.command(datasetsCommand)
	.command(categoriesCommand)
	.command(extractCommand)
	.command(documentCommand)
	.command(depsCommand)
	.command(connectorsCommand)
	.command(slackCommand)
	.command(gdriveCommand)
	.command(xCommand)
	.command(usageCommand)
	.use(experimentalModePlugin())
	.use(
		updateNotifierPlugin({
			packageName: pkg.name,
			currentVersion: pkg.version,
			cache: {
				adapter: cacheAdaptor,
			},
		}),
	)
	.use(versionPlugin(pkg.version))
	.use(helpPlugin())
	.use(autoCompletePlugin({ mode: "help" }))
	.use(
		skillPlugin({
			version: pkg.version,
			defaultScope: "global",
			instructions: `
### Nia Workflow

**Use indexed Nia sources first. Web is the fallback, not the default.**

#### Rules

1. **Never use web fetch or run** \`nia search web\` **or** \`nia search deep\` **before checking whether the source already exists in Nia.**
2. If the user names a repo, doc site, paper, or dataset, treat it as a **known source** and stay inside Nia first.
3. Do not skip to web because it seems faster. Indexed Nia content is usually more complete and reliable.

#### Required Workflow

1. **Check what exists already**
   - Use \`nia repos list\`, \`nia sources list\`, \`nia sources summary\`, or \`nia sources resolve <identifier>\`.
2. **If the source is already indexed, search inside Nia**
   - Use \`nia search query\` or \`nia search universal\` for answers.
   - Use \`nia repos tree\`, \`nia repos grep\`, \`nia repos read\`, \`nia sources tree\`, \`nia sources ls\`, \`nia sources grep\`, and \`nia sources read\` for direct inspection.
   - Use \`nia document query <source-id> "question"\` to ask AI questions about indexed PDFs/documents with citations.
3. **If the source is not indexed but the identifier is known, index it first**
   - Repo: \`nia repos index <owner/repo>\`
   - Docs: \`nia sources index <root-doc-url>\`
   - Paper: \`nia papers index <arxiv-id-or-url>\`
   - Dataset: \`nia datasets index <dataset-id-or-url>\`
   - Subscribe to global source (instant if already indexed): \`nia sources subscribe <url>\`
   - Upload a PDF: \`nia sources upload <file.pdf>\`
4. **Wait for indexing, then continue in Nia**
   - Indexing usually takes 1-5 minutes.
   - Check progress with \`nia repos status\` or \`nia sources list\`.
5. **Use web search only as a last resort**
   - Only use \`nia search web\` or \`nia search deep\` when the source is truly unknown, cannot be indexed from the given information, or indexed search is clearly insufficient.

#### Extraction & Document Intelligence

- **Extract tables from PDFs**: \`nia extract table <source> --schema '...'\` — structured data extraction with JSON schema.
- **Detect elements in documents**: \`nia extract detect <source>\` — find symbols, annotations, and elements.
- **Engineering drawings**: \`nia extract engineering <source>\` — extract dimensions, tolerances, title blocks from technical drawings.
- **Query extractions**: \`nia extract query <extraction-id> "question"\` — ask follow-up questions about extracted data.
- **Document agent**: \`nia document query <source-id> "question"\` — AI-powered Q&A with citations over any indexed document.

#### Dependency Management

- **Analyze a manifest**: \`nia deps analyze package.json\` — detect dependencies and find documentation URLs.
- **Auto-subscribe to docs**: \`nia deps subscribe package.json\` — automatically index documentation for all dependencies.

#### Integrations

- **Slack**: \`nia slack install-token --token xoxb-...\`, \`nia slack grep <id> "pattern"\`, \`nia slack messages <id>\`
- **Google Drive**: \`nia gdrive install\`, \`nia gdrive browse <id>\`, \`nia gdrive index <id>\`
- **X/Twitter**: \`nia x install <username> --token <bearer>\`
- **Connectors**: \`nia connectors list\`, \`nia connectors install <type>\`

#### Source Filesystem Operations

- **Write files**: \`nia sources write <id> <path> --body "content"\` or \`--file local.txt\`
- **Move/rename**: \`nia sources mv <id> <old-path> <new-path>\`
- **Create dirs**: \`nia sources mkdir <id> <path>\`
- **Delete files**: \`nia sources rm <id> <path>\`

#### Defaults

- Use \`nia search query\` for targeted questions about specific repos, docs, papers, datasets, or local folders.
- For docs, index the **root URL**, not a single page. Example: \`https://docs.stripe.com\`.
- Most commands accept flexible identifiers such as UUID, display name, or URL.
- Use \`nia sources subscribe <url>\` for instant access to already-indexed global sources.
			`,
		}),
	);

await main.execute();
