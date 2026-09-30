import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/evals/cases", { recursive: true });
cpSync("evals/cases/corpus.json", "dist/evals/cases/corpus.json");
