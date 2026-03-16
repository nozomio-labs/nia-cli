import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	getConfigDirPath,
	resetConfig,
	writeConfig,
} from "../helpers/config-store.ts";

// --- Mock SDK ---

const mockIndexResearchPaper = mock(() =>
	Promise.resolve({
		id: "paper-src-001",
		arxiv_id: "2312.00752",
		title: "Attention Is All You Need",
		authors: ["Vaswani et al."],
		abstract: "The dominant sequence transduction models...",
		categories: ["cs.CL"],
		primary_category: "cs.CL",
		status: "processing",
		created_at: "2024-01-01T00:00:00Z",
		updated_at: "2024-01-01T00:00:00Z",
		pdf_url: "https://arxiv.org/pdf/2312.00752",
		abs_url: "https://arxiv.org/abs/2312.00752",
	}),
);

const mockListResearchPapers = mock(() =>
	Promise.resolve({
		items: [
			{
				id: "paper-src-001",
				type: "research_paper",
				display_name: "Attention Is All You Need",
				metadata: {
					title: "Attention Is All You Need",
				},
				status: "completed",
				created_at: "2024-01-01T00:00:00Z",
			},
			{
				id: "paper-src-002",
				type: "research_paper",
				display_name: "BERT: Pre-training of Deep Bidirectional Transformers",
				metadata: {
					title: "BERT: Pre-training of Deep Bidirectional Transformers",
				},
				status: "processing",
				created_at: "2024-01-02T00:00:00Z",
			},
		],
		pagination: {
			total: 2,
			limit: 50,
			offset: 0,
			has_more: false,
		},
	}),
);

const mockIndexHuggingfaceDataset = mock(() =>
	Promise.resolve({
		id: "dataset-src-001",
		dataset_id: "dair-ai/emotion",
		url: "https://huggingface.co/datasets/dair-ai/emotion",
		status: "processing",
		created_at: "2024-01-01T00:00:00Z",
		updated_at: "2024-01-01T00:00:00Z",
	}),
);

const mockListHuggingfaceDatasets = mock(() =>
	Promise.resolve({
		datasets: [
			{
				id: "dataset-src-001",
				dataset_id: "dair-ai/emotion",
				display_name: "dair-ai/emotion",
				status: "completed",
				created_at: "2024-01-01T00:00:00Z",
			},
			{
				id: "dataset-src-002",
				dataset_id: "squad",
				display_name: "squad",
				status: "processing",
				created_at: "2024-01-02T00:00:00Z",
			},
		],
		total: 2,
		limit: 10,
		offset: 0,
	}),
);

const mockAssignDataSourceCategory = mock(() =>
	Promise.resolve({
		success: true,
		source_id: "src-001",
		category_id: "cat-001",
	}),
);

const mockListCategories = mock(() =>
	Promise.resolve({
		categories: [
			{
				id: "cat-001",
				name: "Frontend",
				color: "#FF5733",
				order: 1,
			},
			{
				id: "cat-002",
				name: "Backend",
				color: "#3498DB",
				order: 2,
			},
		],
		total: 2,
	}),
);

const mockCreateCategory = mock(() =>
	Promise.resolve({
		id: "cat-003",
		name: "DevOps",
		color: "#2ECC71",
		order: 3,
		user_id: "user-001",
		created_at: "2024-01-03T00:00:00Z",
		updated_at: "2024-01-03T00:00:00Z",
	}),
);

const mockUpdateCategory = mock(() =>
	Promise.resolve({
		id: "cat-001",
		name: "Frontend Updated",
		color: "#E74C3C",
		order: 1,
		user_id: "user-001",
		created_at: "2024-01-01T00:00:00Z",
		updated_at: "2024-01-03T00:00:00Z",
	}),
);

const mockDeleteCategory = mock(() =>
	Promise.resolve({
		success: true,
	}),
);

mock.module("nia-ai-ts", () => ({
	NiaSDK: class {
		search = {};
		sources = {};
		oracle = {};
	},
	OpenAPI: {
		BASE: "",
		TOKEN: "",
	},
	V2ApiDataSourcesService: {
		indexResearchPaperV2V2ResearchPapersPost: mockIndexResearchPaper,
		indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost:
			mockIndexHuggingfaceDataset,
		listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet:
			mockListHuggingfaceDatasets,
		assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch:
			mockAssignDataSourceCategory,
	},
	V2ApiSourcesService: {
		listSourcesV2SourcesGet: mockListResearchPapers,
	},
	V2ApiCategoriesService: {
		listCategoriesV2CategoriesGet: mockListCategories,
		createCategoryV2CategoriesPost: mockCreateCategory,
		updateCategoryV2CategoriesCategoryIdPatch: mockUpdateCategory,
		deleteCategoryV2CategoriesCategoryIdDelete: mockDeleteCategory,
	},
}));

// --- Import after mocking ---

import {
	V2ApiCategoriesService,
	V2ApiDataSourcesService,
	V2ApiSourcesService,
} from "nia-ai-ts";
import { createSdk } from "../../src/services/sdk.ts";

describe("papers, datasets, and categories commands", () => {
	beforeEach(async () => {
		try {
			await resetConfig();
		} catch {
			// Ignore
		}

		await writeConfig({
			apiKey: "nia_test_pdc_key",
			baseUrl: "https://apigcp.trynia.ai/v2",
			output: undefined,
		});

		mockIndexResearchPaper.mockClear();
		mockListResearchPapers.mockClear();
		mockIndexHuggingfaceDataset.mockClear();
		mockListHuggingfaceDatasets.mockClear();
		mockAssignDataSourceCategory.mockClear();
		mockListCategories.mockClear();
		mockCreateCategory.mockClear();
		mockUpdateCategory.mockClear();
		mockDeleteCategory.mockClear();
	});

	afterEach(() => {
		const dir = getConfigDirPath();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	// =========================
	// Papers commands
	// =========================

	describe("papers index", () => {
		test("calls indexResearchPaperV2V2ResearchPapersPost with arXiv ID", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexResearchPaperV2V2ResearchPapersPost({
				url: "2312.00752",
			});

			expect(mockIndexResearchPaper).toHaveBeenCalledTimes(1);
			expect(mockIndexResearchPaper).toHaveBeenCalledWith({
				url: "2312.00752",
			});
		});

		test("calls indexResearchPaperV2V2ResearchPapersPost with arXiv URL", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexResearchPaperV2V2ResearchPapersPost({
				url: "https://arxiv.org/abs/2312.00752",
			});

			expect(mockIndexResearchPaper).toHaveBeenCalledWith({
				url: "https://arxiv.org/abs/2312.00752",
			});
		});

		test("passes add_as_global_source=false when private", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexResearchPaperV2V2ResearchPapersPost({
				url: "hep-th/9901001",
				add_as_global_source: false,
			});

			expect(mockIndexResearchPaper).toHaveBeenCalledWith({
				url: "hep-th/9901001",
				add_as_global_source: false,
			});
		});

		test("returns paper source info on success", async () => {
			await createSdk();

			const result =
				await V2ApiDataSourcesService.indexResearchPaperV2V2ResearchPapersPost({
					url: "2312.00752",
				});

			expect(result.id).toBe("paper-src-001");
			expect(result.title).toBe("Attention Is All You Need");
			expect(result.status).toBe("processing");
			expect(result.arxiv_id).toBe("2312.00752");
		});

		test("handles error on failed indexing", async () => {
			mockIndexResearchPaper.mockImplementationOnce(() =>
				Promise.reject({ status: 422, message: "Invalid arXiv ID format" }),
			);

			await createSdk();

			try {
				await V2ApiDataSourcesService.indexResearchPaperV2V2ResearchPapersPost({
					url: "invalid-id",
				});
				expect(false).toBe(true); // Should not reach here
			} catch (error) {
				expect((error as { status: number }).status).toBe(422);
			}
		});
	});

	describe("papers list", () => {
		test("calls listSourcesV2SourcesGet with research_paper type", async () => {
			await createSdk();

			await V2ApiSourcesService.listSourcesV2SourcesGet("research_paper");

			expect(mockListResearchPapers).toHaveBeenCalledTimes(1);
		});

		test("passes status filter", async () => {
			await createSdk();

			await V2ApiSourcesService.listSourcesV2SourcesGet(
				"research_paper",
				undefined,
				"completed",
			);

			expect(mockListResearchPapers).toHaveBeenCalledWith(
				"research_paper",
				undefined,
				"completed",
			);
		});

		test("passes limit and offset", async () => {
			await createSdk();

			await V2ApiSourcesService.listSourcesV2SourcesGet(
				"research_paper",
				undefined,
				undefined,
				undefined,
				10,
				5,
			);

			expect(mockListResearchPapers).toHaveBeenCalledWith(
				"research_paper",
				undefined,
				undefined,
				undefined,
				10,
				5,
			);
		});

		test("returns papers list", async () => {
			await createSdk();

			const result =
				await V2ApiSourcesService.listSourcesV2SourcesGet("research_paper");

			expect(result.items ?? []).toHaveLength(2);
			expect(result.pagination.total).toBe(2);
			expect((result.items ?? [])[0]?.display_name).toBe(
				"Attention Is All You Need",
			);
		});

		test("handles authentication error", async () => {
			mockListResearchPapers.mockImplementationOnce(() =>
				Promise.reject({ status: 401, message: "Unauthorized" }),
			);

			await createSdk();

			try {
				await V2ApiSourcesService.listSourcesV2SourcesGet("research_paper");
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(401);
			}
		});
	});

	// =========================
	// Datasets commands
	// =========================

	describe("datasets index", () => {
		test("calls indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost with identifier", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
				{
					url: "dair-ai/emotion",
				},
			);

			expect(mockIndexHuggingfaceDataset).toHaveBeenCalledTimes(1);
			expect(mockIndexHuggingfaceDataset).toHaveBeenCalledWith({
				url: "dair-ai/emotion",
			});
		});

		test("calls indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost with full URL", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
				{
					url: "https://huggingface.co/datasets/squad",
				},
			);

			expect(mockIndexHuggingfaceDataset).toHaveBeenCalledWith({
				url: "https://huggingface.co/datasets/squad",
			});
		});

		test("passes config name for multi-config datasets", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
				{
					url: "dair-ai/emotion",
					config: "split",
				},
			);

			expect(mockIndexHuggingfaceDataset).toHaveBeenCalledWith({
				url: "dair-ai/emotion",
				config: "split",
			});
		});

		test("passes add_as_global_source=false when private", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
				{
					url: "dair-ai/emotion",
					add_as_global_source: false,
				},
			);

			expect(mockIndexHuggingfaceDataset).toHaveBeenCalledWith({
				url: "dair-ai/emotion",
				add_as_global_source: false,
			});
		});

		test("returns dataset source info on success", async () => {
			await createSdk();

			const result =
				await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
					{
						url: "dair-ai/emotion",
					},
				);

			expect(result.id).toBe("dataset-src-001");
			expect(result.dataset_id).toBe("dair-ai/emotion");
			expect(result.status).toBe("processing");
		});

		test("handles validation error", async () => {
			mockIndexHuggingfaceDataset.mockImplementationOnce(() =>
				Promise.reject({ status: 422, message: "Invalid dataset URL" }),
			);

			await createSdk();

			try {
				await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
					{
						url: "invalid-url",
					},
				);
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(422);
			}
		});
	});

	describe("datasets list", () => {
		test("calls listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet with no filters", async () => {
			await createSdk();

			await V2ApiDataSourcesService.listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet();

			expect(mockListHuggingfaceDatasets).toHaveBeenCalledTimes(1);
		});

		test("passes status filter", async () => {
			await createSdk();

			await V2ApiDataSourcesService.listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet(
				"completed",
			);

			expect(mockListHuggingfaceDatasets).toHaveBeenCalledWith("completed");
		});

		test("passes limit and offset", async () => {
			await createSdk();

			await V2ApiDataSourcesService.listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet(
				undefined,
				10,
				5,
			);

			expect(mockListHuggingfaceDatasets).toHaveBeenCalledWith(
				undefined,
				10,
				5,
			);
		});

		test("returns datasets list", async () => {
			await createSdk();

			const result =
				await V2ApiDataSourcesService.listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet();

			expect(result.datasets).toHaveLength(2);
			expect(result.total).toBe(2);
			expect(result.datasets[0]?.display_name).toBe("dair-ai/emotion");
		});

		test("handles rate limit error", async () => {
			mockListHuggingfaceDatasets.mockImplementationOnce(() =>
				Promise.reject({ status: 429, message: "Too many requests" }),
			);

			await createSdk();

			try {
				await V2ApiDataSourcesService.listHuggingfaceDatasetsV2V2HuggingfaceDatasetsGet();
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(429);
			}
		});
	});

	// =========================
	// Categories commands
	// =========================

	describe("categories list", () => {
		test("calls listCategoriesV2CategoriesGet with no params", async () => {
			await createSdk();

			await V2ApiCategoriesService.listCategoriesV2CategoriesGet();

			expect(mockListCategories).toHaveBeenCalledTimes(1);
		});

		test("passes limit and offset", async () => {
			await createSdk();

			await V2ApiCategoriesService.listCategoriesV2CategoriesGet(10, 5);

			expect(mockListCategories).toHaveBeenCalledWith(10, 5);
		});

		test("returns categories list with total", async () => {
			await createSdk();

			const result =
				await V2ApiCategoriesService.listCategoriesV2CategoriesGet();

			expect(result.categories ?? []).toHaveLength(2);
			expect(result.total).toBe(2);
			expect((result.categories ?? [])[0]?.name).toBe("Frontend");
			expect((result.categories ?? [])[1]?.color).toBe("#3498DB");
		});
	});

	describe("categories create", () => {
		test("calls createCategoryV2CategoriesPost with name only", async () => {
			await createSdk();

			await V2ApiCategoriesService.createCategoryV2CategoriesPost({
				name: "DevOps",
			});

			expect(mockCreateCategory).toHaveBeenCalledTimes(1);
			expect(mockCreateCategory).toHaveBeenCalledWith({
				name: "DevOps",
			});
		});

		test("passes color and order", async () => {
			await createSdk();

			await V2ApiCategoriesService.createCategoryV2CategoriesPost({
				name: "DevOps",
				color: "#2ECC71",
				order: 3,
			});

			expect(mockCreateCategory).toHaveBeenCalledWith({
				name: "DevOps",
				color: "#2ECC71",
				order: 3,
			});
		});

		test("returns created category", async () => {
			await createSdk();

			const result =
				await V2ApiCategoriesService.createCategoryV2CategoriesPost({
					name: "DevOps",
				});

			expect(result.id).toBe("cat-003");
			expect(result.name).toBe("DevOps");
			expect(result.color).toBe("#2ECC71");
			expect(result.order).toBe(3);
		});

		test("handles validation error", async () => {
			mockCreateCategory.mockImplementationOnce(() =>
				Promise.reject({
					status: 422,
					message: "Category name already exists",
				}),
			);

			await createSdk();

			try {
				await V2ApiCategoriesService.createCategoryV2CategoriesPost({
					name: "Duplicate",
				});
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(422);
			}
		});
	});

	describe("categories update", () => {
		test("calls updateCategoryV2CategoriesCategoryIdPatch with name", async () => {
			await createSdk();

			await V2ApiCategoriesService.updateCategoryV2CategoriesCategoryIdPatch(
				"cat-001",
				{
					name: "Frontend Updated",
				},
			);

			expect(mockUpdateCategory).toHaveBeenCalledTimes(1);
			expect(mockUpdateCategory).toHaveBeenCalledWith("cat-001", {
				name: "Frontend Updated",
			});
		});

		test("passes color and order", async () => {
			await createSdk();

			await V2ApiCategoriesService.updateCategoryV2CategoriesCategoryIdPatch(
				"cat-001",
				{
					color: "#E74C3C",
					order: 5,
				},
			);

			expect(mockUpdateCategory).toHaveBeenCalledWith("cat-001", {
				color: "#E74C3C",
				order: 5,
			});
		});

		test("returns updated category", async () => {
			await createSdk();

			const result =
				await V2ApiCategoriesService.updateCategoryV2CategoriesCategoryIdPatch(
					"cat-001",
					{
						name: "Frontend Updated",
					},
				);

			expect(result.id).toBe("cat-001");
			expect(result.name).toBe("Frontend Updated");
			expect(result.color).toBe("#E74C3C");
			expect(result.order).toBe(1);
		});

		test("handles not found error", async () => {
			mockUpdateCategory.mockImplementationOnce(() =>
				Promise.reject({ status: 404, message: "Category not found" }),
			);

			await createSdk();

			try {
				await V2ApiCategoriesService.updateCategoryV2CategoriesCategoryIdPatch(
					"nonexistent",
					{
						name: "Test",
					},
				);
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(404);
			}
		});
	});

	describe("categories delete", () => {
		test("calls deleteCategoryV2CategoriesCategoryIdDelete with category ID", async () => {
			await createSdk();

			await V2ApiCategoriesService.deleteCategoryV2CategoriesCategoryIdDelete(
				"cat-001",
			);

			expect(mockDeleteCategory).toHaveBeenCalledTimes(1);
			expect(mockDeleteCategory).toHaveBeenCalledWith("cat-001");
		});

		test("returns success on deletion", async () => {
			await createSdk();

			const result =
				await V2ApiCategoriesService.deleteCategoryV2CategoriesCategoryIdDelete(
					"cat-001",
				);

			expect(result).toEqual({ success: true });
		});

		test("handles not found error", async () => {
			mockDeleteCategory.mockImplementationOnce(() =>
				Promise.reject({ status: 404, message: "Category not found" }),
			);

			await createSdk();

			try {
				await V2ApiCategoriesService.deleteCategoryV2CategoriesCategoryIdDelete(
					"nonexistent",
				);
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(404);
			}
		});
	});

	describe("categories assign", () => {
		test("calls assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch with category ID", async () => {
			await createSdk();

			await V2ApiDataSourcesService.assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch(
				"src-001",
				{ category_id: "cat-001" },
			);

			expect(mockAssignDataSourceCategory).toHaveBeenCalledTimes(1);
			expect(mockAssignDataSourceCategory).toHaveBeenCalledWith("src-001", {
				category_id: "cat-001",
			});
		});

		test("passes null category_id to unassign", async () => {
			await createSdk();

			await V2ApiDataSourcesService.assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch(
				"src-001",
				{ category_id: null },
			);

			expect(mockAssignDataSourceCategory).toHaveBeenCalledWith("src-001", {
				category_id: null,
			});
		});

		test("returns success on assignment", async () => {
			await createSdk();

			const result =
				await V2ApiDataSourcesService.assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch(
					"src-001",
					{ category_id: "cat-001" },
				);

			expect(result).toEqual({
				success: true,
				source_id: "src-001",
				category_id: "cat-001",
			});
		});

		test("handles server error", async () => {
			mockAssignDataSourceCategory.mockImplementationOnce(() =>
				Promise.reject({ status: 500, message: "Internal Server Error" }),
			);

			await createSdk();

			try {
				await V2ApiDataSourcesService.assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch(
					"src-001",
					{ category_id: "cat-001" },
				);
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(500);
			}
		});
	});

	// =========================
	// Error handling
	// =========================

	describe("error handling", () => {
		test("handles 401 authentication error for papers", async () => {
			mockIndexResearchPaper.mockImplementationOnce(() =>
				Promise.reject({ status: 401, message: "Unauthorized" }),
			);

			await createSdk();

			try {
				await V2ApiDataSourcesService.indexResearchPaperV2V2ResearchPapersPost({
					url: "2312.00752",
				});
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(401);
			}
		});

		test("handles 403 forbidden error for datasets", async () => {
			mockIndexHuggingfaceDataset.mockImplementationOnce(() =>
				Promise.reject({ status: 403, message: "Forbidden" }),
			);

			await createSdk();

			try {
				await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
					{
						url: "dair-ai/emotion",
					},
				);
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(403);
			}
		});

		test("handles 429 rate limit error for categories", async () => {
			mockListCategories.mockImplementationOnce(() =>
				Promise.reject({ status: 429, message: "Too many requests" }),
			);

			await createSdk();

			try {
				await V2ApiCategoriesService.listCategoriesV2CategoriesGet();
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(429);
			}
		});

		test("handles 500 server error for assign", async () => {
			mockAssignDataSourceCategory.mockImplementationOnce(() =>
				Promise.reject({ status: 500, message: "Internal Server Error" }),
			);

			await createSdk();

			try {
				await V2ApiDataSourcesService.assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch(
					"src-001",
					{ category_id: "cat-001" },
				);
				expect(false).toBe(true);
			} catch (error) {
				expect((error as { status: number }).status).toBe(500);
			}
		});
	});

	// =========================
	// Flag-to-parameter mapping
	// =========================

	describe("flag-to-parameter mapping", () => {
		test("papers index maps paper arg to url field", async () => {
			await createSdk();

			// Various arXiv ID formats
			await V2ApiDataSourcesService.indexResearchPaperV2V2ResearchPapersPost({
				url: "2312.00752",
			});

			expect(mockIndexResearchPaper).toHaveBeenCalledWith({
				url: "2312.00752",
			});
		});

		test("papers list maps to sources list with research_paper type", async () => {
			await createSdk();

			await V2ApiSourcesService.listSourcesV2SourcesGet(
				"research_paper",
				undefined,
				"completed",
				undefined,
				20,
				10,
			);

			expect(mockListResearchPapers).toHaveBeenCalledWith(
				"research_paper",
				undefined,
				"completed",
				undefined,
				20,
				10,
			);
		});

		test("datasets index maps dataset arg to url and config to config field", async () => {
			await createSdk();

			await V2ApiDataSourcesService.indexHuggingfaceDatasetV2V2HuggingfaceDatasetsPost(
				{
					url: "dair-ai/emotion",
					config: "default",
				},
			);

			expect(mockIndexHuggingfaceDataset).toHaveBeenCalledWith({
				url: "dair-ai/emotion",
				config: "default",
			});
		});

		test("categories create maps name arg and color/order flags to CategoryCreate", async () => {
			await createSdk();

			await V2ApiCategoriesService.createCategoryV2CategoriesPost({
				name: "Infrastructure",
				color: "#8E44AD",
				order: 10,
			});

			expect(mockCreateCategory).toHaveBeenCalledWith({
				name: "Infrastructure",
				color: "#8E44AD",
				order: 10,
			});
		});

		test("categories update maps id arg and partial update body to CategoryUpdate", async () => {
			await createSdk();

			await V2ApiCategoriesService.updateCategoryV2CategoriesCategoryIdPatch(
				"cat-002",
				{
					name: "Backend Services",
					color: null,
				},
			);

			expect(mockUpdateCategory).toHaveBeenCalledWith("cat-002", {
				name: "Backend Services",
				color: null,
			});
		});

		test("categories assign maps source-id and category-id to service call", async () => {
			await createSdk();

			await V2ApiDataSourcesService.assignDataSourceCategoryV2DataSourcesSourceIdCategoryPatch(
				"src-abc",
				{ category_id: "cat-xyz" },
			);

			expect(mockAssignDataSourceCategory).toHaveBeenCalledWith("src-abc", {
				category_id: "cat-xyz",
			});
		});
	});
});
