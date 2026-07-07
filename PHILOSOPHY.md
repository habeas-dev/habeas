# The Habeas Philosophy

> *Software reflects values. Habeas is no exception.*

Habeas was not created because exporting receipts is difficult.

It was created because the current relationship between people and their own data is fundamentally backwards.

This document explains the principles that guide the project.

---

# Your data should not be trapped

Every day we generate data.

Receipts.

Invoices.

Bank statements.

Investment reports.

Tax records.

Insurance documents.

Loyalty history.

Purchase history.

Most of it already belongs to us.

Yet obtaining it is often surprisingly difficult.

Many websites provide:

- no API;
- no bulk export;
- limited document retention;
- interfaces designed only for manual browsing.

The result is a strange situation:

People own their data, but cannot practically use it.

Habeas exists to reduce that gap.

---

# The browser is already trusted

Most data extraction projects begin by asking for credentials.

We believe that is the wrong starting point.

The website already trusts your browser.

You already authenticated.

You already completed MFA.

Your browser already has access.

Instead of recreating authentication somewhere else, Habeas simply operates where trust already exists.

This is the simplest architecture.

It is also the safest.

---

# Credentials should never become infrastructure

Many services ask users to hand over their passwords.

Those passwords become another database.

Another attack surface.

Another liability.

Habeas deliberately refuses this model.

The project should never need to know who you are.

Only your browser needs to know that.

---

# Local-first is not a feature

Many software projects advertise "local-first" as an optional capability.

For Habeas, it is a design constraint.

Everything important happens on the user's own machine.

The project operates no aggregation servers.

The project stores no user credentials.

The project stores no personal data.

Your data moves only because **you** decided where it should go.

---

# Access is more important than format

Different providers expose different information.

Trying to force everything into one universal data model sounds attractive.

In practice, it usually means losing information.

Habeas deliberately avoids this.

Sources expose their own native outputs.

PDF remains PDF.

A spreadsheet remains a spreadsheet.

Structured JSON remains exactly what the provider produced.

Applications are free to interpret those outputs however they choose.

Habeas standardizes **how** data is retrieved, not **what** that data should look like.

---

# The ecosystem should outlive the project

A healthy ecosystem should not depend on a single team.

For that reason:

- Sources are independent.
- Sinks are independent.
- Source definitions are independent.
- The Runtime is generic.

Supporting one more website should not require changing the architecture.

Growing the ecosystem should become easier over time, not harder.

---

# Community before code

One person cannot keep up with every bank, supermarket, broker and online service in the world.

Neither can a small team.

The long-term goal is therefore not to write every Source.

It is to make creating new Sources increasingly accessible.

The Session Recorder exists for this reason.

A contributor should be able to capture a normal browsing session, review the inferred Source definition, improve it, and share it with everyone else.

Knowledge should become reusable.

---

# We are not fighting websites

Habeas is often described as a scraper.

That misses the point.

The project is not trying to defeat websites.

It is not trying to bypass authentication.

It is not trying to impersonate users.

It is not trying to harvest public data.

The user is already logged in.

The website has already decided that the user may access those documents.

Habeas simply helps the user retrieve them more effectively.

---

# Automation should respect ownership

Automation is not the objective.

Ownership is.

Automation is only useful when it gives people greater control over information that already belongs to them.

If automation requires giving up control, it solves one problem by creating another.

Habeas intentionally chooses the opposite trade-off.

---

# Simplicity is a security feature

Every additional server...

Every additional credential...

Every additional cloud service...

Every additional synchronization layer...

...creates another place where something can go wrong.

Whenever there are two architectures with equivalent capabilities, Habeas should prefer the simpler one.

Not because simplicity is elegant.

Because simplicity is easier to trust.

---

# Open ecosystems beat closed integrations

Websites evolve.

APIs disappear.

Companies are bought.

Products are abandoned.

Closed integrations eventually decay.

Open Source definitions can continue evolving as long as a community finds them useful.

That makes the ecosystem more resilient than any individual integration.

---

# The project should remain boring

"Boring" is a compliment.

Habeas should avoid unnecessary complexity.

It should avoid fashionable technology.

It should avoid hype.

It should prefer understandable solutions over clever ones.

People are trusting it with their own data.

Predictability matters more than novelty.

---

# What Habeas believes

In the end, the project is guided by a few simple beliefs.

- Your data should remain accessible.
- Authentication belongs to the user.
- Credentials should stay on the user's device.
- Local execution is preferable to remote execution.
- Native documents are valuable.
- Open ecosystems are stronger than closed ones.
- Community scales better than centralization.
- Simplicity is a feature.
- Trust is earned through architecture.

Everything else is implementation.

Whenever a future decision conflicts with these principles, the principles should win.
