-- CreateTable
CREATE TABLE "Game" (
    "uid" TEXT NOT NULL,
    "stakes" TEXT NOT NULL DEFAULT '',
    "commit1" TEXT NOT NULL,
    "commit2" TEXT NOT NULL,
    "player1" TEXT NOT NULL,
    "player2" TEXT NOT NULL,
    "choice1" INTEGER NOT NULL,
    "choice2" INTEGER NOT NULL,
    "salt1" TEXT NOT NULL,
    "salt2" TEXT NOT NULL,
    "encryptedChoice1" TEXT NOT NULL DEFAULT '',
    "encryptedChoice2" TEXT NOT NULL DEFAULT '',
    "eloChange1" INTEGER NOT NULL DEFAULT 0,
    "eloChange2" INTEGER NOT NULL DEFAULT 0,
    "declined" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" INTEGER NOT NULL DEFAULT 0,
    "abandoned" BOOLEAN NOT NULL DEFAULT false,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "invalidated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "Attestation" (
    "uid" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "attester" TEXT NOT NULL,
    "schemaId" TEXT NOT NULL,
    "isOffchain" BOOLEAN NOT NULL DEFAULT true,
    "refUID" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "gameUID" TEXT NOT NULL,
    "packageObjString" TEXT NOT NULL,
    "onChainTimestamp" INTEGER NOT NULL DEFAULT 0,
    "timestamp" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Attestation_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "WhitelistAttestation" (
    "uid" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isOffchain" BOOLEAN NOT NULL DEFAULT true,
    "chain" TEXT NOT NULL DEFAULT 'mainnet',
    "packageObjString" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,

    CONSTRAINT "WhitelistAttestation_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "Player" (
    "address" TEXT NOT NULL,
    "ensName" TEXT,
    "ensAvatar" TEXT,
    "elo" INTEGER NOT NULL DEFAULT 0,
    "whiteListTimestamp" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Link" (
    "player1" TEXT NOT NULL,
    "player2" TEXT NOT NULL,
    "default" BOOLEAN NOT NULL,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("player1","player2")
);

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_player1_fkey" FOREIGN KEY ("player1") REFERENCES "Player"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_player2_fkey" FOREIGN KEY ("player2") REFERENCES "Player"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_player1_player2_fkey" FOREIGN KEY ("player1", "player2") REFERENCES "Link"("player1", "player2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attestation" ADD CONSTRAINT "Attestation_gameUID_fkey" FOREIGN KEY ("gameUID") REFERENCES "Game"("uid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhitelistAttestation" ADD CONSTRAINT "WhitelistAttestation_recipient_fkey" FOREIGN KEY ("recipient") REFERENCES "Player"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_player1_fkey" FOREIGN KEY ("player1") REFERENCES "Player"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_player2_fkey" FOREIGN KEY ("player2") REFERENCES "Player"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_player1_player2_fkey" FOREIGN KEY ("player1", "player2") REFERENCES "Link"("player2", "player1") ON DELETE RESTRICT ON UPDATE CASCADE;
