"""Reset launched campaigns to draft, inject RCS into their channel priority,
   clear their old communications, then relaunch fresh."""
import sys
sys.path.insert(0, r"D:\xeno-crm\backend\crm-api")
from sqlalchemy import delete
from app.db.session import SessionLocal
from app.models import Campaign, Communication, CommunicationEvent, WebhookDelivery

db = SessionLocal()

for c in db.query(Campaign).all():
    policy = c.channel_policy_json or {}
    priority = list(policy.get("priority", []))
    if "rcs" not in priority:
        # insert rcs after whatsapp if present, else at the front
        if "whatsapp" in priority:
            idx = priority.index("whatsapp")
            priority.insert(idx + 1, "rcs")
        else:
            priority.insert(0, "rcs")
        policy["priority"] = priority
        c.channel_policy_json = policy

    # clear old comms + their events so relaunch starts clean
    comm_ids = [r[0] for r in db.query(Communication.id).filter(Communication.campaign_id == c.id).all()]
    if comm_ids:
        db.execute(delete(CommunicationEvent).where(CommunicationEvent.communication_id.in_(comm_ids)))
        db.execute(delete(WebhookDelivery).where(WebhookDelivery.provider_event_id.in_(
            db.query(CommunicationEvent.event_id).filter(CommunicationEvent.communication_id.in_(comm_ids)).subquery().select()
        )))
        db.execute(delete(Communication).where(Communication.id.in_(comm_ids)))

    c.status = "draft"
    c.launched_at = None
    print(f"  reset #{c.id} {c.name!r} -> draft · priority={priority}")

db.commit()
db.close()
print("\nDone. Now relaunching all via HTTP…")
