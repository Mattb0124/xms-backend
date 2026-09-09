-- 0044 The contact record (Client Portal functional 4; CP-02). A contact was
-- an address the intake pipeline matched on: an email, a display name and a
-- status. The desk needs the person behind it, so a consultant ringing about
-- a case knows who they are calling and from where.
--
-- Everything here is optional. A contact still arrives from an inbound email
-- with nothing but an address, and nothing about that path changes: the
-- columns fill in when someone knows the answer.

alter table acct.contacts
  -- Voice, in the form the client gave it. Not normalised: a number is
  -- dialled by a person, and the extensions, country codes and "ask for
  -- Sam" that real directories carry do not survive normalisation.
  add column phone text,
  -- What they do, in their own organisation's words.
  add column job_title text,
  -- Where they sit, for a desk covering more than one region.
  add column time_zone text,
  -- Anything a consultant should know before speaking to them.
  add column notes text;

comment on column acct.contacts.phone is 'As given: extensions and country codes are kept verbatim.';
comment on column acct.contacts.job_title is 'The role in the client organisation, their words.';
comment on column acct.contacts.time_zone is 'IANA zone where known, for calling hours.';
comment on column acct.contacts.notes is 'What a consultant should know before speaking to them.';
