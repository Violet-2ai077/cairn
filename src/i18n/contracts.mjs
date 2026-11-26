import * as kernel from '../kernel/contracts.mjs';
import { runtimeLocale } from './locale.mjs';

// Runtime entry points select a locale; kernel builders never consult process state.
export const buildAntiRecencyContract = options => kernel.buildAntiRecencyContract(options, runtimeLocale);
export const buildStagingExtractorPrompt = head => kernel.buildStagingExtractorPrompt(head, runtimeLocale);
export const buildStrictCompactorPrompt = options => kernel.buildStrictCompactorPrompt(options, runtimeLocale);
export const buildAuthorityCheckoutContract = head => kernel.buildAuthorityCheckoutContract(head, runtimeLocale);
export const buildScopedAuthorityContract = options => kernel.buildScopedAuthorityContract(options, runtimeLocale);
export const buildScopedStagingExtractorPrompt = (scope, head, options) =>
  kernel.buildScopedStagingExtractorPrompt(scope, head, options, runtimeLocale);
