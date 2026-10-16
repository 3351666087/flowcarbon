import { installJobSchema } from "./index";

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL or DATABASE_URL is required");
  process.exit(1);
}
installJobSchema(url)
  .then(() => console.log("job schema installed"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
