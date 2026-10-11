/**
 * #16318 — onomeo provider registration and free-tier catalog validation.
 *
 * Verifies:
 *  - Provider is registered in the open-sse registry with correct format and endpoints
 *  - Provider is listed in the apikey gateways with hasFree=true
 *  - All 19 free models are present in FREE_MODEL_BUDGETS with correct metadata
 *  - Free models have recurring-daily type with poolKey="onomeo"
 *  - The catalog curated date was bumped
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import {
  FREE_MODEL_BUDGETS,
  FREE_CATALOG_CURATED_AT,
} from "../../open-sse/config/freeModelCatalog.data.ts";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.ts";

test("onomeo provider is registered in open-sse registry", () => {
  const entry = getRegistryEntry("onomeo");
  assert.ok(entry, "onomeo provider must exist in registry");
  assert.equal(entry.id, "onomeo");
  assert.equal(entry.alias, "onm");
  assert.equal(entry.format, "openai");
  assert.equal(entry.executor, "default");
  assert.equal(entry.baseUrl, "https://onomeo.com/v1/chat/completions");
  assert.equal(entry.modelsUrl, "https://onomeo.com/v1/models");
  assert.equal(entry.authType, "apikey");
  assert.equal(entry.authHeader, "bearer");
  assert.equal(entry.defaultContextLength, 131072);
  assert.equal(entry.passthroughModels, true);
  assert.ok(
    Array.isArray(entry.models) && entry.models.length >= 19,
    "should have at least 19 models"
  );
});

test("onomeo is listed in apikey gateways with hasFree=true", () => {
  const gateway = AI_PROVIDERS["onomeo"];
  assert.ok(gateway, "onomeo must exist in AI_PROVIDERS");
  assert.equal(gateway.id, "onomeo");
  assert.equal(gateway.alias, "onm");
  assert.equal(gateway.hasFree, true);
  assert.ok(
    gateway.freeNote && gateway.freeNote.length > 0,
    "freeNote must describe the free tier"
  );
  assert.ok(
    gateway.apiHint && gateway.apiHint.includes("onomeo.com/v1"),
    "apiHint must reference onomeo endpoint"
  );
  assert.equal(gateway.passthroughModels, true);
});

test("all 19 onomeo free models are in FREE_MODEL_BUDGETS with correct structure", () => {
  const freeModels = [
    "auto",
    "deepseek-v4-flash",
    "glm-5.2",
    "deepseek-v4.1-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gpt-oss-20b",
    "muse-glimmer-30b",
    "glm-5.3-flash",
    "codestral-latest",
    "ministral-14b-latest",
    "hy4-preview",
    "glm-4.5-flash",
    "glm-4.6v-flash",
    "glm-4.7-flash",
  ];

  const onomeoBudgets = FREE_MODEL_BUDGETS.filter((b) => b.provider === "onomeo");
  assert.equal(
    onomeoBudgets.length,
    freeModels.length,
    `expected ${freeModels.length} onomeo models, got ${onomeoBudgets.length}`
  );

  for (const modelId of freeModels) {
    const budget = onomeoBudgets.find((b) => b.modelId === modelId);
    assert.ok(budget, `onomeo model ${modelId} must exist in FREE_MODEL_BUDGETS`);
    assert.equal(budget.provider, "onomeo");
    assert.equal(budget.poolKey, "onomeo");
    assert.equal(budget.freeType, "recurring-daily");
    assert.ok(budget.monthlyTokens > 0, `${modelId} must have positive monthlyTokens`);
    assert.ok(
      budget.displayName && budget.displayName.length > 0,
      `${modelId} must have displayName`
    );
    assert.ok(
      ["caution", "avoid", "ambiguous", "ok"].includes(budget.tos),
      `${modelId} tos must be valid`
    );

    // Gemini models and auto/gpt-oss/muse-glimmer/glm-5.3-flash/glm-4.5/4.6v/4.7 should have trainsOnPrompts
    const shouldTrain = [
      "auto",
      "gpt-oss-20b",
      "muse-glimmer-30b",
      "glm-5.3-flash",
      "glm-4.5-flash",
      "glm-4.6v-flash",
      "glm-4.7-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
    ].includes(modelId);
    if (shouldTrain) {
      assert.equal(budget.trainsOnPrompts, true, `${modelId} should have trainsOnPrompts=true`);
    } else if (
      [
        "deepseek-v4-flash",
        "glm-5.2",
        "deepseek-v4.1-flash",
        "codestral-latest",
        "ministral-14b-latest",
        "hy4-preview",
      ].includes(modelId)
    ) {
      // These explicitly don't have trainsOnPrompts in the source data
      assert.equal(budget.trainsOnPrompts, undefined, `${modelId} should not have trainsOnPrompts`);
    }
  }
});

test("FREE_CATALOG_CURATED_AT was updated for onomeo addition", () => {
  assert.equal(FREE_CATALOG_CURATED_AT, "2026-10-11");
});
