// altimate_change start — explicit registration entry point for altimate validators
import { ValidatorRegistry } from "../../session/validators/registry"
import { DbtSchemaVerifyValidator } from "./dbt-schema-verify"

/**
 * Explicit registration function for the altimate-domain validators. Called
 * from prompt.ts at the validator hook site (NOT as a side-effect import) so
 * bun's --single bundler cannot tree-shake the registration away when no
 * other code imports `ValidatorRegistry`.
 *
 * Idempotent: ValidatorRegistry.register is keyed by name so repeat calls
 * just overwrite.
 */
export function registerAltimateValidators(): void {
  ValidatorRegistry.register(DbtSchemaVerifyValidator)
}
// altimate_change end
