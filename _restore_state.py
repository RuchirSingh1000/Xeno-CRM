"""Undo the RCS-related demo mutations and rebuild a clean launchable state.

1. Restore consent rows:
   - whatsapp_opted_in = True for everyone non-DND (we had flipped a subset off)
   - rcs_opted_in = False for everyone (we had flipped a subset on)
2. Reset each campaign's channel_policy.priority back to [whatsapp, sms, email].
3. Wipe stale Communications + their CommunicationEvents (the 1611 stuck queued).
4. Reset campaign status -> draft so they can be relaunched cleanly.
"""
import sys
sys.path.insert(0, r"D:\xeno-crm\backend\crm-api")
from sqlalchemy import delete
from app.db.session import SessionLocal
from app.models import Campaign, Communication, CommunicationEvent, WebhookDelivery, Consent

db = SessionLocal()

# 1. Consent restore
consents = db.query(Consent).all()
restored_wa = 0
cleared_rcs = 0
for c in consents:
    if not c.dnd_status and not c.whatsapp_opted_in:
        c.whatsapp_opted_in = True
        restored_wa += 1
    if c.rcs_opted_in:
        c.rcs_opted_in = False
        cleared_rcs += 1
print(f"consent: re-opted-in {restored_wa} for WhatsApp, cleared {cleared_rcs} RCS flags")

# 2 + 3 + 4: per-campaign
for c in db.query(Campaign).all():
    policy = c.channel_policy_json or {}
    policy["priority"] = ["whatsapp", "sms", "email"]
    c.channel_policy_json = policy

    comm_ids = [r[0] for r in db.query(Communication.id).filter(Communication.campaign_id == c.id).all()]
    if comm_ids:
        # delete events first, then comms — FK chain
        db.execute(delete(CommunicationEvent).where(CommunicationEvent.communication_id.in_(comm_ids)))
        db.execute(delete(Communication).where(Communication.id.in_(comm_ids)))
    c.status = "draft"
    c.launched_at = None
    c.completed_at = None
    print(f"  reset #{c.id} {c.name!r} -> draft, cleared {len(comm_ids)} comms")

db.commit()
db.close()
print("\nDone. Relaunch all 7 via HTTP next.")
