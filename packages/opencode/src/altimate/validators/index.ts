// altimate_change start — auto-register altimate-domain validators
import { ValidatorRegistry } from "../../session/validators/registry"
import { DbtSchemaVerifyValidator } from "./dbt-schema-verify"

/**
 * Side-effect import: registers all altimate-domain validators on module load.
 * Importing this module is enough to make the validators dispatch.
 *
 * New domains add a registration here. The framework itself
 * (`session/validators/`) is domain-agnostic.
 */
ValidatorRegistry.register(DbtSchemaVerifyValidator)
// altimate_change end
