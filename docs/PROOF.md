# Saltline v2: the headline loop, run on the live testnet contract

These three accounts are **the team's own test accounts**, made on 14 Nov 2026 between 11:20 and 11:38 UTC to show
that the loop works. They are not players and do not show traction.

- Contract: `v2.saltline.testnet`. Site: https://saltline-lac.vercel.app/play/?game=v2
- Each account is a fresh guest wallet the game makes in a headless Chrome, funded and registered by the site's own
  faucet (`/api/faucet`). **3 faucet accounts used** (0.1 testnet NEAR each). No key was read, printed or copied.
- Every tx hash below was checked with the RPC `tx` method: **44 of 44 final success** (6 faucet + 38 game calls),
  and **0 live calls were refused**. Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

| Who | Account (implicit) | Callsign | Faucet: register · fund |
| --- | --- | --- | --- |
| A | `e438b181df43a96cc8d6c9de4191904653ecc4da923c075d824d7288ed536692` | TEAM TEST A | `2T76VEXEcPCP9CnwLE1AhHW5sbTjgFgFXEWNRic8vG6T` · `GJNvnJF7EFfx6pcJ39diwKGNpwwMxJE9YazsxdARmK4a` |
| B | `f6ab4464990bd30c9b01346611d1c710744ffd319db25870476e44dcc53559e6` | TEAM TEST B | `6LbkRXRM6QzQGioMZuUzmxRjH1cpbSEuDwjp7En3b38t` · `ASFauYn8Xw5NrrSbSwReY2ktLUuAPESvtQAxVw96GDE` |
| C | `555ce76ae4362737e285e630a40ed5c7eb3d54eb0b0cacec655891996b32d0c8` | TEAM TEST C | `38LDE75QJ6avdSXpG8RzFJna1ELHKbojoZURyoKJrWaw` · `4dTkJQQwoR9prq4TaZ38QsnuEoSRT7t6NB9XLkPgD6GN` |

## The loop, step by step

Each row was confirmed afterwards by reading the contract's own views (`weapon`, `balances`, `profile`, `economy`,
`wrecks`, `impound`, `harbormaster`).

| # | Who | Method | Tx hash | Confirmed by (before → after) |
| --- | --- | --- | --- | --- |
| 1a | A | start_raid (raid 9) | [6WFVrfE1QvLJYbRdCxRC4WRSfmrowXdiVWqHwcqdKgfF](https://testnet.nearblocks.io/txns/6WFVrfE1QvLJYbRdCxRC4WRSfmrowXdiVWqHwcqdKgfF) | issue rifle, invoice 150 at the fence |
| 1b | A | extract | [EeLEQJKbHmasAsMaBkgE5EB5doSmowMA71bhWSJJiyYb](https://testnet.nearblocks.io/txns/EeLEQJKbHmasAsMaBkgE5EB5doSmowMA71bhWSJJiyYb) | minted 3 copper + 3 rotor (7 gulls destroyed); invoice 750, arrears 187 |
| 1c | A | start_raid (raid 11) | [6wA2JHSi96rowevSgWGqpuks3C7Po8tpMHPXhqhQ7RJe](https://testnet.nearblocks.io/txns/6wA2JHSi96rowevSgWGqpuks3C7Po8tpMHPXhqhQ7RJe) | invoice 268 at the fence |
| 1d | A | extract | [HyU8YmX76qYmHq58N7cbtA6baP7eq65tEoo2SfCCuDf9](https://testnet.nearblocks.io/txns/HyU8YmX76qYmHq58N7cbtA6baP7eq65tEoo2SfCCuDf9) | balances: copper 5, chips 4, rotor 3, scrip 150 |
| 1e | A | build `stevedore` | [9zkmR9VANRex6Xr2GfTxYrid2cab7nEkCo4enLGnAX3H](https://testnet.nearblocks.io/txns/9zkmR9VANRex6Xr2GfTxYrid2cab7nEkCo4enLGnAX3H) | `weapon("S-000005")`: maker A, owner A, owners 1, held, grade C. A balances → copper 1, chips 1, scrip 60; `economy.weapons_built` 4 → 5 |
| 2a | A | list_weapon 400 | [4CoBQeEhjZifu4Ff8iq8vJAaFdvgzUtpxF8TfGcD1and](https://testnet.nearblocks.io/txns/4CoBQeEhjZifu4Ff8iq8vJAaFdvgzUtpxF8TfGcD1and) | listing 1, gun `listed` |
| 2b | B | start_raid (raid 10) | [C2MRfS9MXWckTBqP8j8YbWgJGJFPgeqpcr3not1JByZy](https://testnet.nearblocks.io/txns/C2MRfS9MXWckTBqP8j8YbWgJGJFPgeqpcr3not1JByZy) | |
| 2c | B | extract | [k9jCZim8zeXBXMXbuGDPJpBp3CqGyD3RRkKqnwypaqH](https://testnet.nearblocks.io/txns/k9jCZim8zeXBXMXbuGDPJpBp3CqGyD3RRkKqnwypaqH) | 3 copper + 3 servo, invoice 776 |
| 2d | B | sell ×6 to Moss | see appendix | B scrip 150 → 627 |
| 2e | B | buy_listing 1 | [D5dyzmYwGw4VM3hwhTyBhLU5UTuoUmr1gFd6mwtnAQPM](https://testnet.nearblocks.io/txns/D5dyzmYwGw4VM3hwhTyBhLU5UTuoUmr1gFd6mwtnAQPM) | owner A → B, owners 1 → 2. B scrip 627 → 227. A scrip 60 → 452 (384 proceeds + 8 royalty). A `royalties` 0 → 8. `economy.last_sales` [] → stevedore C [400] |
| 3a | B | list_weapon 300 | [9buYXGbgF67FiguihF25iwgNG8Z3qFEzhKCHBknkt2pS](https://testnet.nearblocks.io/txns/9buYXGbgF67FiguihF25iwgNG8Z3qFEzhKCHBknkt2pS) | listing 2 |
| 3b | C | start_raid (12) · extract · sell ×6 | [4DHSWW…](https://testnet.nearblocks.io/txns/4DHSWWSwFk82NM3neff6cRf9kcyY2nemwjfxkwn94oAz) · [EAJjaX…](https://testnet.nearblocks.io/txns/EAJjaXnxQaN7kNCuqXVVYiaaxFpScW4zeCY8tceo9WRd) | C scrip 150 → 828 |
| 3c | C | buy_listing 2 | [2MUcGmRUXXwd4UTWWCMD8hhKtJRPYx1NnvnN6JwdLdtx](https://testnet.nearblocks.io/txns/2MUcGmRUXXwd4UTWWCMD8hhKtJRPYx1NnvnN6JwdLdtx) | owner B → C, owners 3. **A scrip 238 → 244 (+6 = 2% of 300), A `royalties` 8 → 14.** B 227 → 515 (+288 = 96%). C 828 → 528. `last_sales` [400, 300] |
| 4a | C | start_raid (13) with S-000005 | [HamYFbg7oQoee7HEMeuFD1hCsEvEY5ZFNSZCVDQ2dJu1](https://testnet.nearblocks.io/txns/HamYFbg7oQoee7HEMeuFD1hCsEvEY5ZFNSZCVDQ2dJu1) | gun `raid`; shooter held "PAC-9K Stevedore · C" |
| 4b | C | die `machines` | [Gk8LRWvyGwktty6EtWaeh8vmQNWRdi8ZCX6qcXLmMvuS](https://testnet.nearblocks.io/txns/Gk8LRWvyGwktty6EtWaeh8vmQNWRdi8ZCX6qcXLmMvuS) | killed by Inspection Units' fire after 18 s, 0 Bailiff grabs. `wrecks()`: new wreck **id 2, spot 15, owner C, weapon S-000005 state `wreck`** |
| 5a | A | start_raid (14) | [49sispbAFdtW6QvLkRZgnnYcfEooxmUTEpGCZ6hW9YwG](https://testnet.nearblocks.io/txns/49sispbAFdtW6QvLkRZgnnYcfEooxmUTEpGCZ6hW9YwG) | wreck 2 was in A's manifest on the first try (newest wreck not A's) |
| 5b | A | extract (report `wrecks: [2]`) | [sfB3AZ6bYoMiMGpycnKmPU7dqFpp31tBcaZRpPs7X9U](https://testnet.nearblocks.io/txns/sfB3AZ6bYoMiMGpycnKmPU7dqFpp31tBcaZRpPs7X9U) | `weapon`: owner C → A, owners 3 → 4, **recovered 0 → 1**, condition 100 → 85, value 600 → 552, held. Wreck 2 gone from `wrecks()` |
| 6 | A | settle 214 | [7n9Chn3Zeqcz3ZXxZc1hAgQ17oicuyamzmYTijdw5E15](https://testnet.nearblocks.io/txns/7n9Chn3Zeqcz3ZXxZc1hAgQ17oicuyamzmYTijdw5E15) | cleared 427 (arrears 427 → 0). **Harbormaster balance 11 → 225, strength 0 → 11** |
| 7a | A | repair | [FCfYnofLDx7DUeeM4juQG5Epr5F4zWcWWRFsnAUSxZUN](https://testnet.nearblocks.io/txns/FCfYnofLDx7DUeeM4juQG5Epr5F4zWcWWRFsnAUSxZUN) | condition 85 → 100, cost 30 scrip + 1 copper, value 552 → 600 |
| 7b | A | build `mag2` | [BuZW8bALQjVRs2yuDvomXcm2FgcMD7tho2dEPRWKb1QN](https://testnet.nearblocks.io/txns/BuZW8bALQjVRs2yuDvomXcm2FgcMD7tho2dEPRWKb1QN) | 2 copper + 1 chips + 30 fee |
| 7c | A | fit `mag2` | [AnDvxXAvvHyA6Mz9ANj9wr65EYE61MbtUooc7j6iRi71](https://testnet.nearblocks.io/txns/AnDvxXAvvHyA6Mz9ANj9wr65EYE61MbtUooc7j6iRi71) | mods [] → [mag2] |
| 7d | A | start_raid (15) with S-000005 | [7aoonsPobiNf34K7qzKMRK8mJbDwT9bWZuwj8RvkErcB](https://testnet.nearblocks.io/txns/7aoonsPobiNf34K7qzKMRK8mJbDwT9bWZuwj8RvkErcB) | invoice 320 at the fence; 3 seals + 15 hounds took the meter to 1,211; Bailiff dispatched |
| 7e | A | die `bailiff` | [E8QLA5h5e4tzzab9znm7e6EWQzCzcLwi5fuTCxVzVEQP](https://testnet.nearblocks.io/txns/E8QLA5h5e4tzzab9znm7e6EWQzCzcLwi5fuTCxVzVEQP) | `impound(A)`: S-000005 state `impound`, fee 240, 48 h |
| 7f | A | buy_back | [wP29AzoQoXGKLXH5EADVm7xobfuanfRuuXyG4pEswMZ](https://testnet.nearblocks.io/txns/wP29AzoQoXGKLXH5EADVm7xobfuanfRuuXyG4pEswMZ) | cost 240, `impound(A)` → [], gun held. A scrip 325 → 85. **Harbormaster 223 → 462, strength 11 → 23** |

## The gun: S-000005

`weapon("S-000005")` now:

```
serial S-000005 · frame stevedore · grade C · quality 43
stats { damage 16, rpm 915, mag 37, recoil 75, reload 94, range 183 } · mods [mag2] · condition 100
maker e438b181…6692 (maker_callsign "TEAM TEST A") · owner e438b181…6692 (A)
built_at 1794655529161 · raids 2 · extractions 0 · owners 4 · recovered 1 · state held · value 600
```

`nft_token` metadata: "PAC-9K Stevedore S-000005 · grade C", "Built by TEAM TEST A · 0 extractions · 4 owners ·
recovered 1 times · condition 100".

Its history, as the contract's `recent` ledger records it (UTC):

```
11:25:29 build        TEAM TEST A built a C-grade Stevedore, S-000005.
11:25:59 listing      TEAM TEST A listed a C-grade Stevedore S-000005 for 400.
11:26:25 market_sale  TEAM TEST B bought TEAM TEST A's C-grade Stevedore S-000005 for 400.
11:27:07 listing      TEAM TEST B listed a C-grade Stevedore S-000005 for 300.
11:28:23 market_sale  TEAM TEST C bought TEAM TEST B's C-grade Stevedore S-000005 for 300.
11:29:01 raid_start   TEAM TEST C went over the fence with a C-grade Stevedore S-000005. 272 on the invoice.
11:29:22 wreck        TEAM TEST C went down at spot 15. a C-grade Stevedore S-000005 and nothing left in a wreck.
11:31:01 recover      TEAM TEST A carried TEAM TEST C's C-grade Stevedore S-000005 out of the yard. It is TEAM TEST A's now.
11:31:37 repair       Moss brought TEAM TEST A's C-grade Stevedore S-000005 up to 100 for 30.
11:31:42 fit          TEAM TEST A fitted an extended magazine to a C-grade Stevedore S-000005.
11:36:41 raid_start   TEAM TEST A went over the fence with a C-grade Stevedore S-000005. 320 on the invoice.
11:37:09 impound      The Bailiff took TEAM TEST A's C-grade Stevedore S-000005. 240 scrip buys it back within 48 hours.
11:37:40 buy_back     TEAM TEST A bought a C-grade Stevedore S-000005 back from the Harbormaster for 240.
```

## The Harbormaster

| When | Balance | Strength | Bonus drones |
| --- | --- | --- | --- |
| Before (11:20) | 11 | 0 | 0 |
| After A's settle of 214 | 225 | 11 | 0 |
| Before the buy-back (decayed) | 223 | 11 | 0 |
| After the buy-back of 240 | 462 | 23 | 0 |

Economy after: scrip_supply 4,727, burned_24h 166, players 12, weapons_built 5, last_sales stevedore C [400, 300].

## What behaved differently from the docs, or wasn't done

1. **The maker's 2% is paid on the first sale too, to the maker selling their own gun.** A got 8 scrip "royalty" on
   its own listing, and it counts in `profile.royalties` (14 = 8 own sale + 6 real resale) and so in the makers
   leaderboard. CONTRACT_V2.md describes this (`buy_listing`: 2% to the maker); GAME.md's "earns 2% every time it is
   *resold*" doesn't. A maker selling its own gun pays 2% in fees, not 4%.
2. **Paying the Harbormaster bought no machines yet.** Strength 23 after 454 scrip paid; bonus drones need strength 25
   (500 scrip held). Matches the formula, but at today's amounts "paying makes everyone's raids harder" has no effect.
3. **The recorded invoice is lower than the meter the player saw** when machines die fast. The Bailiff raid's meter
   reached 1,211; the contract recorded 803, because the client caps reported kills to raid seconds ÷ 4.
4. **A recovered gun's `extractions` stays 0.** Only the gun wielded at extract counts. The NFT reads "0 extractions ·
   4 owners · recovered 1 times" (also a grammar slip: "1 times").
5. **C, not B, died with the gun.** B sold it to C in step 3, so the owner at step 4 was C.
6. `nft_payout` was only read while A was both owner and maker (100% to A); the 2% split for another owner is untested.
7. **How it was played:** the raids ran in the game's own raid module, scripted. The player was invulnerable (except in
   the death raids), drones were cleared every 150 ms, the script teleported to seals, wrecks and the boat, cut uplinks
   with `G.game.debugCut()`, and spawned machines next to the player and destroyed them through their own `damage()`.
   Dock actions (build, list, buy, sell, settle, repair, fit, buy-back) were called on `G.v2.chain`, the client the
   dock uses, not by clicking the dock's buttons. So this proves the contract and the game's chain client, not human
   play or the dock UI.
8. Mock rehearsal: the dev server on 5280 hot-reloaded mid-raid when PR #46 merged (raid/index.ts, mock.ts), dropping
   one mock raid to the title. Re-run passed. The live runs were not affected. On the mock, `settle` and `buyListing`
   were only rehearsed as far as their refusals (no scrip, own listing); both succeeded live.

## Appendix: the other transactions

- B sells: `qFoLu9ExTd5Ntiy8XAiWfwQBG3gjxdQxLyisf8EvHfw`, `J4J9dXn648ctgGZ5M9s21v4LKXvDggfrk8dJAioHN3Qt`,
  `5U9R19kk6NQ928RCUEG6kpXEniDBFuDmF2EzWbNrViZv`, `Hpy3XkPRv3an5Und8V3rDkxHhqwt7tgutcyATaS7m3jx`,
  `C3TsLubA1vb4RQ3MyLBWrE1BvjytK68C1EvEtMfxjG5Q`, `A7EWKbc1KcfM5m2MNV2sYMP8Tj7XxbLwvyM7Tsp26jH4`
- C start_raid 12 `4DHSWWSwFk82NM3neff6cRf9kcyY2nemwjfxkwn94oAz`, extract `EAJjaXnxQaN7kNCuqXVVYiaaxFpScW4zeCY8tceo9WRd`;
  sells `4VS3jBi5eW8CYzNkYPxTPiwKXCsZcP7J3ZRf1iWekVEy`, `ENHKyYXt8j2KLAE8J3soiCtCJ35VGcVL8bchhCMFFcLT`,
  `FNKCQsyU2vWXHCX8fQV5nMLhoDWH1xbKynWLG7iVGAo7`, `C4kG8Ngj4xDMadoCfoS6YvygFYV7kpE7x1KGLo5E86Y1`,
  `AVLyR7rPRTL5cbBWjKCzJeNtwt9St29GLKS3Mw3iUwwE`, `AEwLJuA9utsUXv8DHvt2fFRTWHwomL6ZJ2nww4Kz1hfE`
- A sells before the Bailiff raid: `3RknBiwzXHGPUvXuwbqw57Tk4u2PbLiKK6NsaNj79jxj`, `BYZ39vnToQnrHMRmBxU5nW9WUTK468s1XxNB32XJ1GnQ`

## How it was run

The driver was a scratch script in the style of [`scripts/e2e-v2.mjs`](../scripts/e2e-v2.mjs), which plays one full raid
the same way and prints its hashes; `npm run e2e:v2` makes a fresh set. Every hash above can be checked on the
explorer or with the RPC `tx` method.
