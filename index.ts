import express from 'express'
import axios from "axios";
import cors from 'cors'
import bodyParser from "body-parser";
import {StoreIPFSActionReturn} from "./types";
import verificationMiddleware from './verifyAttestation'
import {
  SchemaEncoder, AttestationShareablePackageObject, ZERO_BYTES, ZERO_BYTES32
} from "@ethereum-attestation-service/eas-sdk";
import dayjs from "dayjs";

import {PrismaClient, Game, Link} from "@prisma/client";

const prisma = new PrismaClient();

import {
  updateEloChangeIfApplicable,
  CHOICE_UNKNOWN,
  CUSTOM_SCHEMAS,
  dbFriendlyAttestation,
  STATUS_UNKNOWN
} from "./utils";
import {ethers} from 'ethers';

const app = express()
const port = 8080

app.use(bodyParser.urlencoded({extended: true}));

app.use(bodyParser.json());
app.use(cors())

// note: build in middleware to verify all attestations
app.post('/newAttestation', verificationMiddleware, async (req, res) => {
  const attestation: AttestationShareablePackageObject = JSON.parse(req.body.textJson)

  if (attestation.sig.message.schema === CUSTOM_SCHEMAS.CREATE_GAME_CHALLENGE) {
    const player1 = attestation.signer
    const player2 = attestation.sig.message.recipient
    const existingLink = await prisma.link.findUnique({
      where: {
        player1_player2: {
          player1: player1,
          player2: player2,
        }
      }
    });

    if (!existingLink) {
      await prisma.link.createMany({
        data: [
          {
            player1: player1,
            player2: player2,
            default: true,
          },
          {
            player1: player2,
            player2: player1,
            default: false,
          }
        ]
      })
    }

    await prisma.game.create({
      data: {
        uid: attestation.sig.uid,
        player1Object: {
          connectOrCreate: {
            where: {
              address: player1
            },
            create: {
              address: player1
            }
          }
        },
        player2Object: {
          connectOrCreate: {
            where: {
              address: player2
            },
            create: {
              address: player2
            }
          }
        },
        commit1: ZERO_BYTES32,
        commit2: ZERO_BYTES32,
        choice1: CHOICE_UNKNOWN,
        choice2: CHOICE_UNKNOWN,
        salt1: ZERO_BYTES32,
        salt2: ZERO_BYTES32,
        link: {
          connect: {
            player1_player2: {
              player1: player1,
              player2: player2,
            }
          }
        }
      }
    })
  } else if (attestation.sig.message.schema === CUSTOM_SCHEMAS.COMMIT_HASH) {
    const schemaEncoder = new SchemaEncoder("bytes32 commitHash");

    const commitHash = (schemaEncoder.decodeData(attestation.sig.message.data))[0].value.value.toString();
    const gameID = attestation.sig.message.refUID;

    const players = await prisma.game.findUnique({
      select: {
        player1: true,
        player2: true,
      },
      where: {
        uid: gameID
      }
    })

    if (attestation.signer === players!.player1) {
      await prisma.game.update({
        where: {
          uid: gameID,
        },
        data: {
          commit1: commitHash,
          updatedAt: dayjs().unix(),
        }
      })
    } else if (attestation.signer === players!.player2) {
      await prisma.game.update({
        where: {
          uid: gameID,
        },
        data: {
          commit2: commitHash,
          updatedAt: dayjs().unix(),
        }
      })
    }
  } else if (attestation.sig.message.schema === CUSTOM_SCHEMAS.DECLINE_GAME_CHALLENGE) {
    const gameID = attestation.sig.message.refUID;

    const players = await prisma.game.findUnique({
      select: {
        player2: true,
      },
      where: {
        uid: gameID,
        commit2: ZERO_BYTES32,
      }
    })

    if (!players) {
      return
    }

    if (attestation.signer === players.player2) {
      await prisma.game.update({
        where: {
          uid: gameID,
        },
        data: {
          declined: true,
          updatedAt: dayjs().unix(),
        }
      })
    }
  }

  await prisma.attestation.create({
    data: dbFriendlyAttestation(attestation)
  })

  const result: StoreIPFSActionReturn = {
    error: null,
    ipfsHash: null,
    offchainAttestationId: attestation.sig.uid
  }
  res.json(result)
})

app.post('/gameStatus', async (req, res) => {
  const {uid} = req.body

  const game = await prisma.game.findUnique({
    where: {
      uid: uid
    },
    include: {
      relevantAttestations: {
        select: {
          packageObjString: true,
        }
      }
    }
  })

  res.json(game)
})

app.post('/incomingChallenges', async (req, res) => {
  const {address}: { address: string } = req.body

  const challenges = await prisma.game.findMany({
    where: {
      player2: address,
      commit2: ZERO_BYTES32,
      declined: false,
    },
  });

  res.json(challenges)
})

app.post('/gamesPendingReveal', async (req, res) => {
  const {address} = req.body

  const games = await prisma.game.findMany({
    select: {
      uid: true,
    },
    where: {
      commit1: {
        not: ZERO_BYTES32
      },
      commit2: {
        not: ZERO_BYTES32
      },
      OR: [
        {
          player1: address,
          choice1: CHOICE_UNKNOWN
        },
        {
          player2: address,
          choice2: CHOICE_UNKNOWN
        }
      ]
    },
  });

  res.json(games.map((game) => game.uid))

})

app.post('/revealMany', async (req, res) => {
  type Reveal = { uid: string, choice: number, salt: string }
  const {reveals}: { reveals: Reveal[] } = req.body

  for (const reveal of reveals) {
    const {uid, choice, salt} = reveal

    let game = await prisma.game.findUnique({
      where: {
        uid: uid
      },
      include: {
        player1Object: true,
        player2Object: true,
      }
    })

    if (!game) {
      continue
    }

    const hashedChoice = ethers.solidityPackedKeccak256(
      ["uint256", "bytes32"],
      [choice, salt]
    );

    if (hashedChoice === game.commit1) {
      game.choice1 = choice
      game.salt1 = salt
    } else if (hashedChoice === game.commit2) {
      game.choice2 = choice
      game.salt2 = salt
    }

    const [eloChange1, eloChange2] = await updateEloChangeIfApplicable(game);


    await prisma.game.update({
      where: {
        uid: reveal.uid
      },
      data: {
        choice1: game.choice1,
        choice2: game.choice2,
        salt1: game.salt1,
        salt2: game.salt2,
        eloChange1: eloChange1,
        eloChange2: eloChange2,
      }
    })
  }

  res.json({})
})

app.post('/myStats', async (req, res) => {
  const {address} = req.body
  const myStats = await prisma.player.findUnique({
    where: {
      address: address
    },
    include: {
      gamesPlayedAsPlayer1: {
        where: {
          declined: false
        }
      },
      gamesPlayedAsPlayer2: {
        where: {
          declined: false
        }
      },
    }
  });

  if (!myStats) {
    return
  }

  const player1Games = myStats.gamesPlayedAsPlayer1
  const player2Games = myStats.gamesPlayedAsPlayer2

  const games = player1Games.concat(player2Games).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({games: games, elo: myStats.elo});
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
  }
};
app.post('/getGraph', async (req, res) => {
  const links = await prisma.link.findMany({
    where: {
      default: true,
    },
    include: {
      opposite: {
        include: {
          gamesPlayed: graphGameFilter,
        }
      },
      gamesPlayed: graphGameFilter,
    },
  });


  res.json({
    nodes: [...new Set(links.map((link) => link.player1)
      .concat(links.map((link) => link.player2)))]
      .map((address) => ({
        id: address,
        group: 1,
      }))
    , links: links.map((link) => ({
      source: link.player1,
      target: link.player2,
      games: link.gamesPlayed
        .concat(link.opposite.gamesPlayed)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((game) => game.choice1 !== CHOICE_UNKNOWN && game.choice2 !== CHOICE_UNKNOWN)
        .map((game) => game.uid),
    }))
      .filter(link => link.games.length > 0)
  })
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
