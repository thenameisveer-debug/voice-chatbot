from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from typing import List
import tempfile
import os
from app.src.adapters.google_cloud_adapter import gcs_blob
import uuid

router = APIRouter(prefix="/documents", tags=["Documents"])

@router.post("/upload")
async def upload_documents(files: List[UploadFile] = File(...)):
    documents = []
    for file in files:
        if file.content_type != "application/pdf":
            raise HTTPException(
                status_code=400,
                detail=f"Invalid file type: {file.filename}"
            )

        # Generate document ID
        document_id = str(uuid.uuid4())

        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        try:
            blob_url = gcs_blob.upload_blob(
                local_file_path=tmp_path,
                filename=file.filename
            )

            documents.append({
                "document_id": document_id,
                "document_url": blob_url,
                "file_name": file.filename
            })

        finally:
            os.remove(tmp_path)

    return {
        "documents": documents
    }
