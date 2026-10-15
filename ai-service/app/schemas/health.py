from typing import Literal

from pydantic import BaseModel


class ServiceStatusResponse(BaseModel):
    status: Literal["ok"]
    service: str
