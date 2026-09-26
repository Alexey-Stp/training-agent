-- CreateTable
CREATE TABLE "IcuConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "icuAthleteId" TEXT NOT NULL,
    "icuAthleteName" TEXT,
    "apiKeyCiphertext" TEXT NOT NULL,
    "apiKeyIv" TEXT NOT NULL,
    "lastActivitySyncAt" TIMESTAMP(3),
    "lastWellnessSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IcuConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IcuConnection_userId_key" ON "IcuConnection"("userId");

-- AddForeignKey
ALTER TABLE "IcuConnection" ADD CONSTRAINT "IcuConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
