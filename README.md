# gta6-twitch-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/jesky1/makefun-gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/jesky1/makefun-gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

A comparable-launch forecaster for Grand Theft Auto VI's launch-day Twitch audience. Given everything recorded up to the end of the release day's first hour, it forecasts each remaining hour's viewer count as five quantiles (5%, 25%, 50%, 75%, 95%).

The case file itself ships dozens of past big launches' release-day curves, and the forecaster rebuilds the day's shape from them at run time: it keeps the launches whose first hour already held 5–85% of their day's peak, prefers the rolling local-midnight releases (GTA VI's own unlock pattern) when at least eight qualify, weights each by how closely its pre-midnight audience pattern matches the case's, and reads each hour's quantiles off the weighted distribution of the pool's log-ratios to their own first hours, with the spread scaled by 0.9. On the kit's four practice launches it scores a mean pinball loss of about 0.201, against the house baseline's 0.387.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ffhnz5an&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
