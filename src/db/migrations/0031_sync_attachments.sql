-- 0031 Attachments across the ServiceNow connector (ServiceNow Sync
-- functional goal 5, SN-06; technical 3.4 step 6 and 3.5). The inbound half
-- needs no new column: the poll carries the metadata and the apply handler
-- records what it did in acct.sync_attachment_links.
--
-- The outbound half needs an event. XMS only ever announced an attachment
-- that failed the scan (`attachment.quarantined`); a file that passes it now
-- announces itself too, so the connector can send it. The subscription is
-- data, like every other connector setting.

update op.connector_types
   set outbound_events = outbound_events || array['attachment.scanned']
 where key = 'servicenow' and not ('attachment.scanned' = any (outbound_events));

alter table acct.sync_outbound drop constraint sync_outbound_event_check;
alter table acct.sync_outbound
  add constraint sync_outbound_event_check
  check (event in ('ticket.updated', 'ticket.transitioned', 'comment.created', 'work_note.created', 'attachment.scanned'));

-- The outbound side asks "has this XMS file already reached this instance",
-- which the external unique index cannot answer.
create unique index ux_acct_sync_attachment_links_xms on acct.sync_attachment_links (instance_id, attachment_id)
  where attachment_id is not null;
