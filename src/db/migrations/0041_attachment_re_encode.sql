-- 0041 What the image re-encode did (Email Intake technical 3 step 4,
-- Security & Tenancy section 6: "inline images from email are re-encoded
-- server-side (strips active content) before storage").
--
-- An image that arrives as bytes is decoded and written out again before it
-- is stored, so the stored file is built from the pixels and carries none of
-- the original container: no EXIF or XMP block, no colour profile, no
-- comment segment, no trailing polyglot. That is a change to the client's
-- file, so the row says it happened and by how much: the sizes and the
-- dimensions before and after, and the content type it was normalised to.
--
-- Null on every row stored any other way (a presigned upload never passes
-- its bytes through the API), so nothing already stored changes meaning.

alter table acct.attachments add column re_encode jsonb;
comment on column acct.attachments.re_encode is
  'Image re-encode record: original and resulting content type, byte size and dimensions.';
