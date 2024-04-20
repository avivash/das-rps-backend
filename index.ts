import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { StoreIPFSActionReturn, LeaderboardPlayer } from "./types";
import verificationMiddleware from "./verifyAttestation";
import {
  SchemaEncoder,
  AttestationShareablePackageObject,
  ZERO_BYTES32,
} from "@ethereum-attestation-service/eas-sdk";
import dayjs from "dayjs";
import { PrismaClient } from "@prisma/client";
import { UndirectedGraph } from "graphology";
import { subgraph } from "graphology-operators";
import {
  updateEloChangeIfApplicable,
  CHOICE_UNKNOWN,
  CUSTOM_SCHEMAS,
  dbFriendlyAttestation,
  RPS_GAME_UID,
  getGameStatus,
  STATUS_PLAYER1_WIN,
  STATUS_PLAYER2_WIN,
  insertToLeaderboard,
  signGameFinalization,
  checkForNewVerifications,
} from "./utils";
import { ethers } from "ethers";
import { loadGraph, addLink } from "./graph";
import { bfsFromNode } from "graphology-traversal";
import { runCron } from "./cron";

const prisma = new PrismaClient();
const graph = new UndirectedGraph();

const app = express();
const port = 8080;

app.use(bodyParser.urlencoded({ extended: true }));

app.use(bodyParser.json());

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://das-rps-frontend.onrender.com",
      "https://das-rps-frontend.onrender.com",
    ],
    credentials: true,
  })
);

app.get("/ok", (req, res) => {
  res.send("ok");
});

app.post("/newAttestation", verificationMiddleware, async (req, res) => {
  const attestation: AttestationShareablePackageObject = JSON.parse(
    req.body.textJson
  );

  try {
    if (
      attestation.sig.message.schema === CUSTOM_SCHEMAS.CREATE_GAME_CHALLENGE
    ) {
      if (attestation.sig.message.refUID !== RPS_GAME_UID) {
        return;
      }

      const numActiveGames = await prisma.game.count({
        where: {
          OR: [
            {
              player1: attestation.signer,
              player2: attestation.sig.message.recipient,
            },
            {
              player1: attestation.sig.message.recipient,
              player2: attestation.signer,
            },
          ],
          declined: false,
          finalized: false,
          invalidated: false,
          abandoned: false,
        },
      });

      if (numActiveGames >= 5) {
        res.json({
          error:
            "You have too many active games with this player. Finish some before starting new ones.",
        });
        return;
      }

      const schemaEncoder = new SchemaEncoder("string stakes");
      const stakes = schemaEncoder
        .decodeData(attestation.sig.message.data)[0]
        .value.value.toString();

      const player1 = attestation.signer;
      const player2 = attestation.sig.message.recipient;
      if (player1 === player2) {
        return;
      }

      await addLink(player1, player2, graph);

      await prisma.game.create({
        data: {
          uid: attestation.sig.uid,
          player1Object: {
            connect: {
              address: player1,
            },
          },
          player2Object: {
            connect: {
              address: player2,
            },
          },
          commit1: ZERO_BYTES32,
          commit2: ZERO_BYTES32,
          choice1: CHOICE_UNKNOWN,
          choice2: CHOICE_UNKNOWN,
          salt1: ZERO_BYTES32,
          salt2: ZERO_BYTES32,
          stakes: stakes,
          updatedAt: dayjs().unix(),
          link: {
            connect: {
              player1_player2: {
                player1: player1,
                player2: player2,
              },
            },
          },
        },
      });
    } else if (attestation.sig.message.schema === CUSTOM_SCHEMAS.COMMIT_HASH) {
      const schemaEncoder = new SchemaEncoder(
        "bytes32 commitHash,bytes encryptedChoice"
      );

      const decoded = schemaEncoder.decodeData(attestation.sig.message.data);
      const commitHash = decoded[0].value.value.toString();
      const encryptedChoice = decoded[1].value.value.toString();
      const gameID = attestation.sig.message.refUID;

      const players = await prisma.game.findUnique({
        select: {
          player1: true,
          player2: true,
        },
        where: {
          uid: gameID,
        },
      });

      if (!players) {
        return;
      }

      if (attestation.signer === players.player1) {
        await prisma.game.update({
          where: {
            uid: gameID,
            commit1: ZERO_BYTES32,
          },
          data: {
            commit1: commitHash,
            updatedAt: dayjs().unix(),
            encryptedChoice1: encryptedChoice,
          },
        });
      } else if (attestation.signer === players.player2) {
        await prisma.game.update({
          where: {
            uid: gameID,
            commit2: ZERO_BYTES32,
          },
          data: {
            commit2: commitHash,
            updatedAt: dayjs().unix(),
            encryptedChoice2: encryptedChoice,
          },
        });
      }
    } else if (
      attestation.sig.message.schema === CUSTOM_SCHEMAS.DECLINE_GAME_CHALLENGE
    ) {
      const gameID = attestation.sig.message.refUID;

      const players = await prisma.game.findUnique({
        select: {
          player2: true,
        },
        where: {
          uid: gameID,
          commit2: ZERO_BYTES32,
        },
      });

      if (!players) {
        return;
      }

      if (attestation.signer === players.player2) {
        await prisma.game.update({
          where: {
            uid: gameID,
          },
          data: {
            declined: true,
            updatedAt: dayjs().unix(),
          },
        });
      }
    }

    await prisma.attestation.create({
      data: dbFriendlyAttestation(attestation),
    });

    const result: StoreIPFSActionReturn = {
      error: null,
      ipfsHash: null,
      offchainAttestationId: attestation.sig.uid,
    };
    res.json(result);
  } catch (e) {
    res.json({ error: `Your attestation was verified, but not indexed. ${e}` });
  }
});

app.post("/gameStatus", async (req, res) => {
  const { uid } = req.body;

  let game = await prisma.game.findUnique({
    where: {
      uid: uid,
    },
    include: {
      relevantAttestations: {
        select: {
          timestamp: true,
          packageObjString: true,
        },
      },
      player1Object: {
        include: {
          whiteListAttestations: {
            select: {
              type: true,
            },
          },
        },
      },
      player2Object: {
        include: {
          whiteListAttestations: {
            select: {
              type: true,
            },
          },
        },
      },
    },
  });

  res.json(game);
});

const finalizedGamesFilter = {
  gamesPlayed: {
    where: {
      finalized: true,
    },
  },
};

app.post("/incomingChallenges", async (req, res) => {
  const { address } = req.body;

  if (!(typeof address === "string")) {
    return;
  }

  const challenges = await prisma.game.findMany({
    where: {
      player2: address,
      commit2: ZERO_BYTES32,
      declined: false,
      invalidated: false,
    },
    include: {
      link: {
        include: {
          ...finalizedGamesFilter,
          opposite: {
            include: finalizedGamesFilter,
          },
        },
      },
      player1Object: {
        include: {
          whiteListAttestations: {
            select: {
              type: true,
            },
          },
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  let winStreaks: number[] = [];
  let gameCounts: number[] = [];

  for (const challenge of challenges) {
    // Get list of games sorted by updatedAt
    const games = challenge.link.gamesPlayed
      .concat(challenge.link.opposite.gamesPlayed)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    gameCounts.push(games.length);
    if (games.length === 0) {
      winStreaks.push(0);
      continue;
    }
    let currIdx = 0;
    let winStreak = 0;

    while (
      currIdx < games.length &&
      ((getGameStatus(games[currIdx]) === STATUS_PLAYER1_WIN &&
        address === games[currIdx].player1) ||
        (getGameStatus(games[currIdx]) === STATUS_PLAYER2_WIN &&
          address === games[currIdx].player2))
    ) {
      winStreak++;
      currIdx++;
    }
    winStreaks.push(winStreak);
  }

  res.json(
    challenges
      .map((challenge, idx) => ({
        uid: challenge.uid,
        player1Object: challenge.player1Object,
        stakes: challenge.stakes,
        winstreak: winStreaks[idx],
        gameCount: gameCounts[idx],
      }))
      .sort(
        (a, b) =>
          b.player1Object.whiteListAttestations.length -
          a.player1Object.whiteListAttestations.length
      )
  );
});

app.post("/gamesPendingReveal", async (req, res) => {
  const { address } = req.body;

  const games = await prisma.game.findMany({
    select: {
      uid: true,
      encryptedChoice1: true,
      encryptedChoice2: true,
      player1: true,
      player2: true,
    },
    where: {
      commit1: {
        not: ZERO_BYTES32,
      },
      commit2: {
        not: ZERO_BYTES32,
      },
      invalidated: false,
      declined: false,
      OR: [
        {
          player1: address,
          choice1: CHOICE_UNKNOWN,
        },
        {
          player2: address,
          choice2: CHOICE_UNKNOWN,
        },
      ],
    },
  });

  res.json(
    games.map((game) => ({
      uid: game.uid,
      encryptedChoice:
        game.player1 === address
          ? game.encryptedChoice1
          : game.encryptedChoice2,
    }))
  );
});

let revealForbidden = new Map<string, boolean>();
app.post("/revealMany", async (req, res) => {
  type Reveal = { uid: string; choice: number; salt: string };
  const { reveals }: { reveals: Reveal[] } = req.body;
  try {
    for (const reveal of reveals) {
      const { uid, choice, salt } = reveal;
      if (!uid || (!choice && choice !== 0) || !salt) {
        return;
      }

      let game = await prisma.game.findUnique({
        where: {
          uid: uid,
          declined: false,
          invalidated: false,
          finalized: false,
        },
        include: {
          player1Object: true,
          player2Object: true,
          relevantAttestations: {
            select: {
              uid: true,
            },
          },
        },
      });

      if (!game) {
        continue;
      }

      const hashedChoice = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32"],
        [choice, salt]
      );

      if (hashedChoice === game.commit1) {
        game.choice1 = choice;
        game.salt1 = salt;

        if (revealForbidden.get(`${uid}1`)) {
          continue;
        } else {
          revealForbidden.set(`${uid}1`, true);
        }
      } else if (hashedChoice === game.commit2) {
        game.choice2 = choice;
        game.salt2 = salt;

        if (revealForbidden.get(`${uid}2`)) {
          continue;
        } else {
          revealForbidden.set(`${uid}2`, true);
        }
      } else {
        continue;
      }

      try {
        const [eloChange1, eloChange2, finalized] =
          await updateEloChangeIfApplicable(game, graph);

        if (finalized) {
          const finalizationAttestation = await signGameFinalization(
            game,
            false
          );
          await prisma.attestation.create({
            data: dbFriendlyAttestation(finalizationAttestation),
          });
        }

        await prisma.game.update({
          where: {
            uid: reveal.uid,
          },
          data: {
            choice1: game.choice1,
            choice2: game.choice2,
            salt1: game.salt1,
            salt2: game.salt2,
            eloChange1: eloChange1,
            eloChange2: eloChange2,
            finalized: finalized,
            updatedAt: dayjs().unix(),
          },
        });
      } catch (e) {
        if (hashedChoice === game.commit1) {
          revealForbidden.delete(`${uid}1`);
        } else if (hashedChoice === game.commit2) {
          revealForbidden.delete(`${uid}2`);
        }
        console.log(e);
      }
    }
  } catch (e) {
    console.log(e);
  }

  res.json({});
});

app.post("/myGames", async (req, res) => {
  const { address, finalized } = req.body;
  if (!(typeof finalized === "boolean") || !(typeof address === "string")) {
    return;
  }

  const myStats = await prisma.player.findUnique({
    where: {
      address: address,
    },
    include: {
      gamesPlayedAsPlayer1: {
        where: {
          declined: false,
          finalized: finalized,
        },
        include: {
          player2Object: {
            include: {
              whiteListAttestations: {
                select: {
                  type: true,
                },
              },
            },
          },
        },
      },
      gamesPlayedAsPlayer2: {
        where: {
          declined: false,
          finalized: finalized,
        },
        include: {
          player1Object: {
            include: {
              whiteListAttestations: {
                select: {
                  type: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!myStats) {
    return;
  }

  const player1Games = myStats.gamesPlayedAsPlayer1.map((game) => ({
    ...game,
    player1Object: {
      ...game.player2Object,
      badges: game.player2Object.whiteListAttestations.map(
        (attestation) => attestation.type
      ),
    },
    player2Object: undefined,
  }));
  const player2Games = myStats.gamesPlayedAsPlayer2.map((game) => ({
    ...game,
    player1Object: {
      ...game.player1Object,
      badges: game.player1Object.whiteListAttestations.map(
        (attestation) => attestation.type
      ),
    },
    player2Object: undefined,
  }));

  const games = player1Games
    .concat(player2Games)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  res.json({
    games: games,
    elo: myStats.elo,
    badges: graph.getNodeAttribute(address, "badges"),
    ensName: myStats.ensName,
    ensAvatar: myStats.ensAvatar,
  });
});

const graphGameFilter = {
  select: {
    uid: true,
    updatedAt: true,
    declined: true,
    choice1: true,
    choice2: true,
  },
  where: {
    declined: false,
  },
};

app.post("/getGraph", async (req, res) => {
  const links = graph.edges().map((edge) => {
    // get destination of edge
    return { source: graph.source(edge), target: graph.target(edge) };
  });

  res.json({
    nodes: graph.nodes().map((node) => ({ id: node })),
    links: links,
  });
});

app.post("/getGamesBetweenPlayers", async (req, res) => {
  const { player1, player2 } = req.body;

  if (typeof player1 !== "string" || typeof player2 !== "string") {
    return;
  }

  const link = await prisma.link.findUnique({
    where: {
      player1_player2: {
        player1: player1,
        player2: player2,
      },
    },
    include: {
      gamesPlayed: graphGameFilter,
      opposite: {
        include: {
          gamesPlayed: graphGameFilter,
        },
      },
    },
  });

  if (!link) return;

  res.json(
    link.gamesPlayed
      .concat(link.opposite.gamesPlayed)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  );
});

app.post("/getElo", async (req, res) => {
  const { address } = req.body;
  if (typeof address !== "string" || !graph.hasNode(address)) {
    return;
  }
  const player = graph.getNodeAttributes(address);
  res.json(player);
});

const filterPlayerObject = {
  select: {
    address: true,
    elo: true,
    ensName: true,
    ensAvatar: true,
    whiteListAttestations: {
      select: {
        type: true,
      },
    },
  },
};

app.post("/ongoing", async (req, res) => {
  const { address } = req.body;
  if (typeof address !== "string") {
    return;
  }
  const games = await prisma.game.findMany({
    where: {
      OR: [
        {
          player1: address,
          OR: [
            {
              choice1: CHOICE_UNKNOWN,
            },
            {
              choice2: CHOICE_UNKNOWN,
            },
          ],
        },
        {
          player2: address,
          OR: [
            {
              choice1: CHOICE_UNKNOWN,
            },
            {
              choice2: CHOICE_UNKNOWN,
            },
          ],
          commit2: {
            not: ZERO_BYTES32,
          },
        },
      ],
      declined: false,
      invalidated: false,
      abandoned: false,
      finalized: false,
    },
    include: {
      player1Object: filterPlayerObject,
      player2Object: filterPlayerObject,
    },
  });

  res.json(games);
});

app.post("/globalLeaderboard", async (req, res) => {
  const players = await prisma.player.findMany({
    orderBy: {
      elo: "desc",
    },
    include: {
      whiteListAttestations: {
        select: {
          type: true,
        },
      },
    },
    take: 30,
  });

  res.json(
    players.map((player) => ({
      elo: player.elo,
      address: player.address,
      badges: player.whiteListAttestations.map((elem) => elem.type),
      ensName: player.ensName,
      ensAvatar: player.ensAvatar,
    }))
  );
});

app.post("/localLeaderboard", async (req, res) => {
  // bfs from address
  const { address } = req.body;

  if (typeof address !== "string" || !graph.hasNode(address)) {
    res.json([]);
    return;
  }
  let leaderboard: LeaderboardPlayer[] = [];
  bfsFromNode(graph, address, (node, attr, depth) => {
    if (depth > 2) {
      return true;
    } else {
      insertToLeaderboard(
        leaderboard,
        {
          address: node,
          elo: attr.elo,
          badges: attr.badges,
          ensName: attr.ensName || null,
          ensAvatar: attr.ensAvatar || null,
        },
        30
      );
      return false;
    }
  });

  res.json(
    leaderboard.map((elem) => ({
      elo: elem.elo,
      address: elem.address,
      badges: elem.badges || [],
      ensName: elem.ensName,
      ensAvatar: elem.ensAvatar,
    }))
  );
});

app.post("/localGraph", async (req, res) => {
  const { address } = req.body;
  if (typeof address !== "string" || !graph.hasNode(address)) {
    res.json({
      nodes: [],
      links: [],
    });
    return;
  }
  let nodes: string[] = [];
  bfsFromNode(graph, address, (node, attr, depth) => {
    if (depth > 2) {
      return true;
    } else {
      nodes.push(node);
      return false;
    }
  });

  const sg = subgraph(graph, nodes);

  const links = sg.edges().map((edge) => {
    // get destination of edge
    return { source: graph.source(edge), target: sg.target(edge) };
  });

  res.json({
    nodes: nodes.map((node) => ({ id: node })),
    links: links,
  });
});

app.post("/checkForBadges", async (req, res) => {
  const { address } = req.body;
  await checkForNewVerifications(address, graph);
  res.json({});
});

const outerRoute = express();
outerRoute.use("/api", app);

async function listen() {
  await loadGraph(graph);
  outerRoute.listen(port, async () => {
    console.log(`app listening on port ${port}`);
  });
}

listen();

runCron(graph);
