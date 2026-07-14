# Habeas Architecture

This document explains the architectural principles behind Habeas.

It is intentionally technology-agnostic. It describes *what* Habeas is and *why* it is designed this way, rather than documenting implementation details.

---

# Design goals

Habeas exists to solve a simple problem:

> Users should be able to retrieve **their own data** from websites that already expose it through their normal web interface.

The project is built around a few fundamental principles.

## Local-first

Everything runs inside the user's own browser.

There are no aggregation servers.

There are no remote logins.

The project never receives user credentials or personal data.

---

## User-controlled authentication

Authentication always remains the responsibility of the user.

Users:

- open the website;
- log in normally;
- complete MFA if required.

Habeas simply operates inside that already authenticated session.

---

## Separation of concerns

Habeas deliberately separates four independent concepts:

- Sources
- Runtime
- Sinks
- Source definitions

Each can evolve independently.

---

# High-level architecture

```
                Session recorder
                       │
                       ▼
              Source definitions
                       │
                       ▼
┌────────────────────────────────────────────┐
│                                            │
│               Habeas Runtime               │
│                                            │
└────────────────────────────────────────────┘
         ▲                           ▲
         │                           │
         │                           │
     Sources                     Sinks
```

The runtime itself knows nothing about Carrefour, banks or investment platforms.

Those are provided by Source definitions.

Likewise, the runtime has no opinion about where retrieved data should go.

That is the responsibility of Sinks.

---

# Sources

A Source knows how to retrieve data from one website.

Examples include:

- supermarkets
- banks
- brokers
- utility companies
- government portals
- online marketplaces

A Source understands:

- navigation
- authentication state
- document discovery
- data extraction

A Source **does not** decide what happens to the retrieved data.

---

# Source outputs

Sources expose the provider's own data.

Typical outputs include:

- PDF documents
- spreadsheets
- structured JSON
- images
- provider-specific formats

An important design decision is that Habeas does **not** attempt to define a universal document format.

Instead:

- documents remain native;
- structured data remains provider-specific;
- consumers decide how to interpret it.

Habeas standardizes **access**, not **content**.

---

# Runtime

The Runtime is responsible for executing Source definitions safely inside the browser.

Its responsibilities include:

- loading Sources;
- coordinating extraction;
- presenting progress to the user;
- managing destinations;
- inventory management;
- a canonical store of everything retrieved (browsable across sources);
- duplicate detection;
- automatic synchronization;
- permissions;
- user interface.

The Runtime deliberately contains no provider-specific logic.

---

# Sinks

Sinks consume data produced by Sources.

Examples include:

- Downloads
- Local folders
- Google Drive
- Dropbox
- WebDAV servers
- S3 (and S3-compatible) object storage
- HTTP endpoints

Future Sinks may include:

- desktop applications;
- personal finance software;
- home automation;
- backup systems;
- document management platforms.

A Sink should not need to understand how each website works.

Its only concern is consuming data exposed through the Runtime.

---

# Source definitions

Source definitions describe how a Source behaves.

They are intentionally independent from the Runtime.

This provides several advantages:

- new websites can be supported without modifying Habeas itself;
- community contributions remain small and reviewable;
- Source development can evolve independently from Runtime releases.

The Runtime executes Source definitions.

It does not contain them.

---

# Session recorder

One of Habeas's goals is making Source creation increasingly accessible.

The Session Recorder assists developers by observing a real browsing session and inferring an initial Source definition.

Typical workflow:

1. The user performs the normal workflow.
2. Habeas records browser activity.
3. An initial Source definition is inferred.
4. The developer reviews the generated result.
5. The Source definition is refined.
6. It may then be contributed back to the community.

The recorder assists development.

It does not replace human review.

---

# Why not server-side?

Many existing data aggregation services operate by:

- collecting credentials;
- storing them;
- logging into websites remotely;
- downloading user data on behalf of users.

Habeas deliberately avoids this architecture.

Instead:

- users authenticate themselves;
- websites see the user's normal browser;
- MFA remains unchanged;
- credentials never leave the device.

This greatly simplifies both trust and privacy.

---

# Why not normalize data?

Many aggregation platforms attempt to create a universal data model.

Habeas deliberately does not.

Different providers expose fundamentally different information.

Trying to normalize every possible document would inevitably discard information or require an ever-growing abstraction layer.

Instead, Habeas standardizes the interface between Sources and Sinks while preserving native outputs.

Applications remain free to interpret those outputs however they choose.

---

# Community-driven ecosystem

The Runtime is intentionally generic.

Its usefulness grows through the ecosystem around it:

- Source definitions
- Sinks
- developer tools
- documentation
- community contributions

This architecture allows the project to scale horizontally without continually increasing Runtime complexity.

---

# Typical data flow

```
User opens website
        │
        ▼
User authenticates
        │
        ▼
Source executes
        │
        ▼
Native documents / JSON produced
        │
        ▼
Runtime
        │
        ▼
Selected Sink
        │
        ▼
Folder / Drive / HTTP / Application
```

Every step occurs under the user's control.

---

# Architectural principles

The project can be summarized by a few simple rules.

- Users authenticate themselves.
- Habeas never stores credentials.
- Everything runs locally.
- Sources retrieve data.
- Sinks consume data.
- Source definitions remain independent.
- Native documents remain unchanged.
- Habeas standardizes access, not content.
- Users decide where their data goes.

These principles should guide future development.

Any new feature should be evaluated against them.

If a feature violates one of these principles, it probably does not belong in Habeas.
