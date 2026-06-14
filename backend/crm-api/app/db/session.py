from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import settings

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
    # Larger pool so concurrent webhooks don't queue up on connections.
    pool_size=20,
    max_overflow=40,
)


# SQLite perf tuning: WAL allows concurrent reads while a writer is active,
# `synchronous=NORMAL` skips per-write fsync (durable on crash, slightly less
# durable on power loss — acceptable for a demo workload), and the larger
# cache + memory-mapped IO keeps hot pages off disk. Without these, the
# webhook receiver becomes the bottleneck under concurrent load (a 180-comm
# campaign launch can overwhelm the default journal mode and the simulator's
# 10s timeout starts dropping events).
if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-65536")  # 64 MB cache
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA busy_timeout=15000")  # wait up to 15s on a lock
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
