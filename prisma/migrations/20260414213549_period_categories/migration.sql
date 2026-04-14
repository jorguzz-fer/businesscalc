/*
  Warnings:

  - You are about to drop the `entries` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "category_section" AS ENUM ('RECEITA', 'DEDUCOES', 'CUSTOS_DIRETOS', 'DESPESAS_OP', 'ENTRADAS_FC', 'SAIDAS_FC');

-- DropForeignKey
ALTER TABLE "entries" DROP CONSTRAINT "entries_period_id_fkey";

-- DropTable
DROP TABLE "entries";

-- CreateTable
CREATE TABLE "period_categories" (
    "id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "section" "category_section" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'money',
    "sort_order" INTEGER NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "monthly" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "period_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "period_categories_period_id_section_sort_order_idx" ON "period_categories"("period_id", "section", "sort_order");

-- AddForeignKey
ALTER TABLE "period_categories" ADD CONSTRAINT "period_categories_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
