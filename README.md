# ⚖️ Judgement Bot

A Discord bot for running structured court cases with judges, lawyers, juries, evidence logging, and automated punishments.

## Features

- 📁 **Case Management** — File, schedule, and close cases with full audit trails
- 👨‍⚖️ **Judge System** — Judges claim cases, schedule hearings, and deliver verdicts
- ⚖️ **Lawyer System** — Prosecutors and defendants can request lawyers
- 🗳️ **Jury System** — Up to 10 jurors can join and vote privately
- 📋 **Evidence Logging** — All messages in case channels are automatically logged
- 🔨 **Punishments** — Verdicts can apply jail, ban, kick, or mute automatically
- 📦 **Auto Archive** — Cases are archived and posted to court records on close
- 📜 **Transcripts** — Export full case transcripts as a text file

## Setup

### Requirements
- Node.js
- PostgreSQL database (e.g. Neon)
- Discord Bot Token

### Environment Variables
```
BOT_TOKEN=your_discord_bot_token
DB_URL=your_postgresql_connection_string
OWNER_ID=your_discord_user_id
PORT=3000
```

### Installation
```bash
npm install
node index.js
```

### First Time Setup
1. Invite the bot with Administrator permission
2. Run `/setup` in your server
3. Fill in the 3 setup modals with your category IDs, channel formats, and role IDs

## Commands

### ⚙️ Admin
| Command | Description |
|---------|-------------|
| `/setup` | Run the setup wizard |
| `/courtconfig` | View current configuration |
| `/assignjudge` | Give a user the judge role |
| `/revokejudge` | Remove the judge role |
| `/transfercase` | Transfer a case to a new judge |
| `/forcestart` | Force start a case |
| `/setstatus` | Manually set a case status |
| `/editcase` | Edit case fields |
| `/jail` | Jail a user |
| `/unjail` | Release a jailed user |
| `/bancasefiling` | Ban a user from filing cases |
| `/unbancasefiling` | Unban a user from filing cases |
| `/casefilingbannedlist` | List filing banned users |

### 📁 Cases
| Command | Description |
|---------|-------------|
| `/filecase` | File a case against a user |
| `/cancelcase` | Cancel your filed case |
| `/caseinfo` | View case details |
| `/listcases` | List all active cases |
| `/casehistory` | View a user's case history |
| `/casecount` | View server case statistics |
| `/exportcase` | DM yourself a case transcript |

### 👨‍⚖️ Judge
| Command | Description |
|---------|-------------|
| `/claimcase` | Claim a case as judge |
| `/startcase` | Schedule a case to go live |
| `/postpone` | Reschedule a case |
| `/endcase` | End a case manually |
| `/dismiss` | Dismiss a case |
| `/verdict` | Set the final verdict and punishment |
| `/jurytally` | View jury vote tally |
| `/kickjuror` | Remove a juror |
| `/strikeevidence` | Strike a message from evidence |

### ⚖️ Lawyers
| Command | Description |
|---------|-------------|
| `/requestlawyer` | Request a user as your lawyer |
| `/acceptlawyer` | Accept a lawyer request |
| `/declinelawyer` | Decline a lawyer request |
| `/revokelawyer` | Fire your lawyer |
| `/replacelawyer` | Force swap a lawyer (admin) |

### 🗳️ Jury
| Command | Description |
|---------|-------------|
| `/joinjury` | Volunteer to join the jury |
| `/vote` | Cast your jury vote |

### 📋 Evidence
| Command | Description |
|---------|-------------|
| `/evidence` | View paginated evidence log |
| `/strikeevidence` | Strike evidence from the log |

### 🔒 Owner Only
| Command | Description |
|---------|-------------|
| `/blacklist` | Globally blacklist a user |
| `/unblacklist` | Remove from blacklist |
| `/blacklistlist` | View all blacklisted users |

## Case Lifecycle

```
FILED → WAITING_LAWYERS → ASSIGNED → SCHEDULED → IN_PROGRESS → CLOSED
                                                ↘ DISMISSED
                                                ↘ CANCELLED
```

## Channel Format Variables

Use `{case_id}` in your channel formats to auto-insert the padded case number.

Example: `«📂»︱case-{case_id}` → `«📂»︱case-003`