from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field, model_validator
from sqlalchemy import JSON, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .common import (
    APIModel,
    OwnerScoped,
    db_dependency,
    get_owned,
    owner_dependency,
    save,
    soft_delete,
    update_version,
)


class ProjectStatus(StrEnum):
    active = "active"
    archived = "archived"


class ResourceKind(StrEnum):
    note = "note"
    task = "task"
    event = "event"
    file = "file"
    mail = "mail"
    finance_transaction = "finance_transaction"
    focus_session = "focus_session"
    ai_chat = "ai_chat"
    agent_session = "agent_session"
    repository = "repository"


class Project(OwnerScoped):
    __tablename__ = "projects"
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(4000), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default=ProjectStatus.active.value, nullable=False)
    settings_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class Resource(OwnerScoped):
    __tablename__ = "resources"
    __table_args__ = (UniqueConstraint("owner_id", "kind", "entity_id", name="uq_resource_owner_kind_entity"),)
    kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    entity_id: Mapped[str] = mapped_column(String(100), nullable=False)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)


class ResourceLink(OwnerScoped):
    __tablename__ = "resource_links"
    __table_args__ = (UniqueConstraint("owner_id", "from_resource_id", "to_resource_id", "relation_type", name="uq_resource_link"),)
    from_resource_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    to_resource_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    relation_type: Mapped[str] = mapped_column(String(80), nullable=False)


class ProjectCreate(APIModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    status: ProjectStatus = ProjectStatus.active
    settings: dict[str, Any] = Field(default_factory=dict)


class ProjectPatch(APIModel):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    status: ProjectStatus | None = None
    settings: dict[str, Any] | None = None


class ProjectOut(APIModel):
    id: str
    owner_id: str
    name: str
    description: str | None
    status: ProjectStatus
    settings: dict[str, Any] = Field(validation_alias="settings_json", serialization_alias="settings")
    version: int
    created_at: datetime
    updated_at: datetime


class ResourceCreate(APIModel):
    kind: ResourceKind
    entity_id: str = Field(min_length=1, max_length=100)
    project_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def cloud_safe_metadata(self):
        if self.kind is ResourceKind.agent_session:
            allowed={"device_id", "project_id", "adapter", "started_at", "last_activity_at", "message_count", "state", "last_indexed_at"}
            forbidden=set(self.metadata) - allowed
            if forbidden: raise ValueError("agent_session metadata contains fields that cannot be stored in cloud")
        blocked={"transcript", "messages", "embedding", "source_code", "absolute_path", "command_history", "prompt"}
        if blocked.intersection(self.metadata): raise ValueError("private agent content cannot be stored in resource metadata")
        return self


class ResourceOut(APIModel):
    id: str
    owner_id: str
    kind: ResourceKind
    entity_id: str
    project_id: str | None
    metadata: dict[str, Any] = Field(validation_alias="metadata_json", serialization_alias="metadata")
    version: int


class LinkCreate(APIModel):
    from_resource_id: str
    to_resource_id: str
    relation_type: str = Field(min_length=1, max_length=80)


class LinkOut(APIModel):
    id: str
    owner_id: str
    from_resource_id: str
    to_resource_id: str
    relation_type: str


class ProjectRepository:
    def __init__(self, session: Session): self.session = session

    def list(self, owner_id: str, *, include_deleted: bool = False) -> list[Project]:
        q = select(Project).where(Project.owner_id == owner_id)
        if not include_deleted: q = q.where(Project.deleted_at.is_(None))
        return list(self.session.scalars(q.order_by(Project.updated_at.desc())))

    def get(self, project_id: str, owner_id: str) -> Project: return get_owned(self.session, Project, project_id, owner_id)


class ProjectService:
    def __init__(self, session: Session): self.session = session; self.repo = ProjectRepository(session)

    def create(self, owner_id: str, data: ProjectCreate) -> Project:
        value = Project(owner_id=owner_id, name=data.name, description=data.description, status=data.status.value, settings_json=data.settings)
        return save(self.session, value)

    def update(self, owner_id: str, project_id: str, data: ProjectPatch) -> Project:
        value = self.repo.get(project_id, owner_id)
        update_version(value, data.version, {"name": data.name, "description": data.description, "status": data.status.value if data.status else None, "settings_json": data.settings})
        self.session.flush(); return value

    def delete(self, owner_id: str, project_id: str, version: int | None = None) -> Project:
        value = self.repo.get(project_id, owner_id); return soft_delete(self.session, value, version)

    def resources(self, owner_id: str, project_id: str) -> list[Resource]:
        self.repo.get(project_id, owner_id)
        return list(self.session.scalars(select(Resource).where(Resource.owner_id == owner_id, Resource.project_id == project_id, Resource.deleted_at.is_(None))))

    def link(self, owner_id: str, data: LinkCreate) -> ResourceLink:
        for rid in (data.from_resource_id, data.to_resource_id): get_owned(self.session, Resource, rid, owner_id)
        if data.from_resource_id == data.to_resource_id: raise HTTPException(422, "Self links are not allowed")
        link = ResourceLink(owner_id=owner_id, from_resource_id=data.from_resource_id, to_resource_id=data.to_resource_id, relation_type=data.relation_type)
        return save(self.session, link)


router = APIRouter(prefix="/api/v1", tags=["projects"])


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return ProjectService(db).repo.list(owner_id)


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(payload: ProjectCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return ProjectService(db).create(owner_id, payload)


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return ProjectService(db).repo.get(project_id, owner_id)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def patch_project(project_id: str, payload: ProjectPatch, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return ProjectService(db).update(owner_id, project_id, payload)


@router.delete("/projects/{project_id}", response_model=ProjectOut)
def delete_project(project_id: str, version: int | None = Query(default=None), db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return ProjectService(db).delete(owner_id, project_id, version)


@router.get("/projects/{project_id}/resources", response_model=list[ResourceOut])
def list_resources(project_id: str, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return ProjectService(db).resources(owner_id, project_id)


@router.post("/resources", response_model=ResourceOut, status_code=201)
def create_resource(payload: ResourceCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    if payload.project_id: get_owned(db, Project, payload.project_id, owner_id)
    return save(db, Resource(owner_id=owner_id, kind=payload.kind.value, entity_id=payload.entity_id, project_id=payload.project_id, metadata_json=payload.metadata))


@router.post("/resource-links", response_model=LinkOut, status_code=201)
def create_link(payload: LinkCreate, db: Session = Depends(db_dependency), owner_id: str = Depends(owner_dependency)):
    return ProjectService(db).link(owner_id, payload)
