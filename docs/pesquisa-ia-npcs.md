# Research: opponent behavior in tennis, boxing, and athletics

Updated: November 28, 2026. Scope: opponents in a camera-based arcade with local simulation; no study was found that directly validates these parameters, the experience of its players, or the local prototype. Primary sources were checked on November 28, 2026. The recommended design is an engineering hypothesis; athlete statistics and results from other games do not guarantee realism, fun, or performance here.

## Findings and limitations

| Primary source | What it shows | Use in this project and limitation |
| --- | --- | --- |
| [Mark and Dill, utility theory](https://www.gdcvault.com/play/1012410/Improving-AI-Decision-Modeling-Through2d) | Models game decisions using utility. | Score legal actions with named factors to make play styles explainable. It does not establish weights or subjective improvement in this game. High confidence in the description; medium confidence in the design recommendation. |
| [Reynolds, steering behaviors](https://www.red3d.com/cwr/papers/1999/gdc99steer.pdf) | Separates goal, steering, and locomotion. | Separate the intent to intercept or evade from movement integration; physical position determines contact. High confidence in the separation; the specific application is a hypothesis. |
| [Match Point AI, full paper](https://arxiv.org/html/2408.05960) | Compares policies in a tennis simulation based on annotated sequences. | Supports comparing policies and both points **and** matches, not copying rates. It does not model player position or movement, or ball speed; nearly half the average agent’s sample comes from ten players. High confidence in the limitation, low confidence in quantitative transfer. |
| [Match Charting Project](https://github.com/JeffSackmann/tennis_MatchChartingProject#license) | Volunteer-annotated point sequences, licensed under CC BY-NC-SA 4.0. | Exploratory research with selection bias; do not import or distribute data, models, or derived parameters until rights and suitability for this project’s use have been checked. Do not use it as a source for reaction or interception times. |
| [Vid2Player3D](https://research.nvidia.com/labs/toronto-ai/vid2player3d/) | Two-layer physical imitation trained on large-scale video. | Demonstrates feasibility, but requires data, training, and simulation outside the current scope; it does not indicate that running a model in the browser would improve the experience. |
| [BoxingVI](https://arxiv.org/html/2511.16524) | The abstract reports 6,915 annotated punches, six classes, 20 videos, and 18 athletes; one figure caption mentions 20 subjects. The data are links and annotations. The paper lists interaction between opponents as future work. | Inspiration for a taxonomy, not a combat policy or webcam front-view detection baseline. Video rights and dataset licensing must be checked before any use. |
| [UTD-MHAD](https://personal.utdallas.edu/~kehtar/UTD-MHAD.html) | Recognition of 27 individual actions captured with Kinect and an inertial sensor. | It does not provide fighting decisions; the local analysis in `plano-boxe.md` documents posture and camera discrepancies. Do not extrapolate performance to real players or punch types. |
| [World Athletics, men’s 100 m](https://worldathletics.org/download/download?filename=51b04ff3-8549-4747-b066-5bd77aeaee38.pdf&urlslug=Men%27s+100m+-+2017+IAAF+World+Championships+Biomechanical+report) and [men’s 400 m](https://worldathletics.org/download/download?filename=8a95b26a-333d-4b05-b935-08f48f434e20.pdf&urlslug=Men%27s+400m+-+2017+IAAF+World+Championships+Biomechanical+report) | Observational reports on elite athletes, also available from the [official index](https://worldathletics.org/about-iaaf/documents/research-centre). In the 2017 London 400 m final, Wayde van Niekerk’s splits were 10.85 / 9.93 / 10.86 / 12.34 s; the first includes the start reaction. | Supports race-dependent acceleration and speed loss; it is not a representative distribution for webcam players and does not justify a mandatory final sprint. Do not copy the times literally. |
| [Ang and Mitchell, dynamic difficulty adjustment evaluation](https://doi.org/10.1145/3116595.3116623) | Compares adjustment methods and player experience in a studied game. | Motivation to test autonomy and sense of control; full-text access returned 403 in this research, so details and effect sizes were not verified. Do not use it as proof that DDA is superior here. |

The [experimental study of anticipation in boxing](https://pubmed.ncbi.nlm.nih.gov/25385452/) compares groups in an experimental screen-based task, not in webcam-controlled fighting; it does not provide a universal reaction time applicable to the NPC. Adaptation to habits and difficulty are separate concepts: the former can change the choice among legal actions, while the latter changes capability or challenge. Start with fixed capability and limited memory, and consider capability-based DDA only after project-specific validation.

## Exploratory measurement of the current race

In Node 24.15.0, I directly ran `Race` from `origin/main` (`f001f6d`) and from the local worktree, with `dt=1/60`, phase `racing`, no player effort, until all three rivals finished; `RestartGesture` was replaced with a stub because it does not participate in the race. This is not a CPU benchmark or a human study. Results in seconds:

| Race | Baseline: Bia / Caio / Davi | Local prototype: Bia / Caio / Davi |
| --- | --- | --- |
| 100 m | 20.200 / 17.833 / 15.976 | 20.651 / 18.365 / 16.604 |
| 200 m | 41.020 / 36.141 / 32.313 | 41.667 / 36.775 / 33.156 |
| 400 m | 89.718 / 78.962 / 70.522 | 91.260 / 80.061 / 72.365 |

These nine deterministic trajectories show that the local attempt made the rivals slower, not that it improved the game; they do not cover variation, interaction with a player, or perceived fairness. The plan requires broader measurements and does not approve the current parameters based on this table.

After implementing athletics profiles, a second run in the same environment used 100 seeds per race (Mulberry32 generator, seeds 1–100), with the same fixed baseline. Means and minimum–maximum ranges in seconds:

| Race | Bia | Caio | Davi |
| --- | --- | --- | --- |
| 100 m | 20.445 (20.139–20.718) | 18.193 (17.918–18.429) | 16.431 (16.206–16.652) |
| 200 m | 41.381 (40.747–41.948) | 36.542 (35.972–37.031) | 32.907 (32.438–33.366) |
| 400 m | 90.542 (89.134–91.798) | 79.469 (78.208–80.550) | 71.742 (70.699–72.761) |

These are synthetic samples from profiles without a camera or player, and do not validate perceived difficulty or browser performance. The ranges are observed minima and maxima, not confidence intervals.

## Data and evaluation

This research has no representative, licensed corpus of matches from this arcade. Synthetic sources can support invariants and regression comparisons; they cannot prove that the human experience improved. Real recordings already expected in `tests/recordings/` are private and optional; without them, camera validation remains pending. Data collected for evaluation should remain local, with consent, and without video in the repository or automatic uploads. Public data may be integrated only after reviewing its source, terms, coverage, and possible derivations.

Compare versions using identical seeds and inputs, with per-scenario results and distributions: rally duration and outcome; frequency of attacks, readable evasions, and out-of-range actions; race curves and times. Test with people of different skill levels, balance the order, and record challenge, clarity, fairness, and fun separately. A win rate alone measures none of these qualities. Set quantitative targets **before** comparing the final version, after measuring the baseline; do not invent measurements or promise performance p95 without real hardware and a protocol.

## Conclusion and gaps

The initial choice is sport-specific AI with bounded observations, execution states, scored legal options, and short-term session memory; its predictability and cost are controllable and testable. This is an engineering proposal, not a proven result showing superiority over machine learning. Do not add an LLM, GOAP, MCTS, or a learned policy to the loop just for its name; investigate them only if evaluation scenarios reveal a need the current solution cannot address. Gaps: real-camera validation, numeric calibration, player studies, frame-time/inference measurements, and license checks for external data. The implementation plan and prototype review are in [plano-ia-npcs.md](plano-ia-npcs.md).
