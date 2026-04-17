import { annotate } from "@crustjs/skills";
import type {
	routes__v2__categories__CategoryCreate,
	routes__v2__categories__CategoryUpdate,
	SourceUpdateRequest,
} from "nia-ai-ts";
import { V2ApiCategoriesService, V2ApiSourcesService } from "nia-ai-ts";
import { app } from "../app.ts";
import { createSdk } from "../services/sdk.ts";
import { withErrorHandling } from "../utils/errors.ts";
import { createOutput } from "../utils/output.ts";

// --- Subcommands ---

const listCommand = app
	.sub("list")
	.meta({ description: "List all categories" })
	.flags({
		limit: {
			type: "number",
			description: "Number of categories to return",
		},
		offset: {
			type: "number",
			description: "Number of categories to skip",
		},
	})
	.run(async ({ flags }) => {
		const fmt = createOutput({ color: flags.color });

		await withErrorHandling({ domain: "Category" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const result = await V2ApiCategoriesService.listCategoriesV2CategoriesGet(
				flags.limit ?? undefined,
				flags.offset ?? undefined,
			);

			const data = result as Record<string, unknown>;
			const categories = (data.categories ?? data.items ?? []) as Array<
				Record<string, unknown>
			>;

			if (categories.length === 0) {
				console.log("No categories found.");
			} else {
				const rows = categories.map((c) => ({
					name: c.name ?? "",
					id: c.id ?? c.category_id ?? "",
					color: c.color ?? "",
					order: c.order ?? "",
				}));
				console.log(fmt.formatTable(rows, ["name", "id", "color", "order"]));

				if (data.total !== undefined) {
					console.log(`\nTotal: ${data.total} categories`);
				}
			}
		});
	});

const createCommand = app
	.sub("create")
	.meta({ description: "Create a new category" })
	.args([
		{
			name: "name",
			type: "string",
			description: "Category name",
			required: true,
		},
	] as const)
	.flags({
		"hex-color": {
			type: "string",
			description: "Hex color (e.g., #FF5733)",
		},
		order: {
			type: "number",
			description: "Display order",
		},
	})
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Category" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const payload: routes__v2__categories__CategoryCreate = {
				name: args.name,
			};

			if (flags["hex-color"]) {
				payload.color = flags["hex-color"];
			}

			if (flags.order !== undefined) {
				payload.order = flags.order;
			}

			const result =
				await V2ApiCategoriesService.createCategoryV2CategoriesPost(payload);

			const data = result as Record<string, unknown>;
			console.log("Category created successfully.");
			if (data.id ?? data.category_id) {
				console.log(`  ID: ${data.id ?? data.category_id}`);
			}
			if (data.name) {
				console.log(`  Name: ${data.name}`);
			}
			if (data.color) {
				console.log(`  Color: ${data.color}`);
			}
			if (data.order !== undefined) {
				console.log(`  Order: ${data.order}`);
			}
		});
	});

const updateCommand = app
	.sub("update")
	.meta({ description: "Update an existing category" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Category ID",
			required: true,
		},
	] as const)
	.flags({
		name: {
			type: "string",
			description: "New category name",
		},
		"hex-color": {
			type: "string",
			description: "Hex color (e.g., #FF5733)",
		},
		order: {
			type: "number",
			description: "New display order",
		},
	})
	.run(async ({ args, flags }) => {
		const fmt = createOutput({ color: flags.color });

		// Require at least one update field
		if (!flags.name && !flags["hex-color"] && flags.order === undefined) {
			fmt.error(
				"Provide at least one field to update: --name, --hex-color, or --order",
			);
			process.exit(1);
		}

		await withErrorHandling({ domain: "Category" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const payload: routes__v2__categories__CategoryUpdate = {};

			if (flags.name) {
				payload.name = flags.name;
			}

			if (flags["hex-color"]) {
				payload.color = flags["hex-color"];
			}

			if (flags.order !== undefined) {
				payload.order = flags.order;
			}

			const result =
				await V2ApiCategoriesService.updateCategoryV2CategoriesCategoryIdPatch(
					args.id,
					payload,
				);

			const data = result as Record<string, unknown>;
			console.log("Category updated successfully.");
			if (data.id ?? data.category_id) {
				console.log(`  ID: ${data.id ?? data.category_id}`);
			}
			if (data.name) {
				console.log(`  Name: ${data.name}`);
			}
			if (data.color) {
				console.log(`  Color: ${data.color}`);
			}
			if (data.order !== undefined) {
				console.log(`  Order: ${data.order}`);
			}
		});
	});

const deleteCommand = app
	.sub("delete")
	.meta({ description: "Delete a category" })
	.args([
		{
			name: "id",
			type: "string",
			description: "Category ID",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		await withErrorHandling({ domain: "Category" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			await V2ApiCategoriesService.deleteCategoryV2CategoriesCategoryIdDelete(
				args.id,
			);

			console.log(`Category ${args.id} deleted successfully.`);
		});
	});

const assignCommand = app
	.sub("assign")
	.meta({
		description: "Assign a category to a data source (pass 'null' to unassign)",
	})
	.args([
		{
			name: "source-id",
			type: "string",
			description: "Data source ID",
			required: true,
		},
		{
			name: "category-id",
			type: "string",
			description: "Category ID to assign, or 'null' to remove category",
			required: true,
		},
	] as const)
	.run(async ({ args, flags }) => {
		const sourceId = args["source-id"];
		const categoryId = args["category-id"];
		const isUnassign = categoryId === "null";

		await withErrorHandling({ domain: "Category" }, async () => {
			await createSdk({ apiKey: flags["api-key"] });

			const payload: SourceUpdateRequest = {
				category_id: isUnassign ? null : categoryId,
			};

			await V2ApiSourcesService.updateSourceV2SourcesSourceIdPatch(
				sourceId,
				payload,
			);

			if (isUnassign) {
				console.log(`Category removed from source ${sourceId}.`);
			} else {
				console.log(`Category ${categoryId} assigned to source ${sourceId}.`);
			}
		});
	});

export const categoriesCommand = annotate(
	app
		.sub("categories")
		.meta({ description: "Create and manage source categories" })
		.command(listCommand)
		.command(createCommand)
		.command(updateCommand)
		.command(deleteCommand)
		.command(assignCommand),
	[
		"Organize indexed sources into categories for better management.",
		"Use `assign` to tag a source with a category, or pass `null` as the category ID to unassign.",
	],
);
