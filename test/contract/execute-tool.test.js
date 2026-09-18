import { executeToolContract, executeToolMigrationContract } from "./execute-tool.js";

executeToolContract("reference", () => async () => "contract result");
executeToolMigrationContract("reference (migration)", () => async () => "contract result");
