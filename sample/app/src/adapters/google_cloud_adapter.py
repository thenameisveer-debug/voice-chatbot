from google.cloud import storage
from google.oauth2 import service_account
from app.src.adapters.logger import logger
from app.config.config import Config
from datetime import datetime
from pathlib import Path
from typing import List

class GCSBlob:
    def __init__(self):
        """
        Initialize Google Cloud Storage client and bind it to:
        - one bucket
        - one fixed prefix (appian-documents)
        """
        try:
            credentials = service_account.Credentials.from_service_account_file(
                Config.gcp_service_account_key_path
            )

            self.client = storage.Client(credentials=credentials)
            self.bucket_name = Config.gcp_bucket_name
            self.root_prefix = Config.gcp_root_prefix
            self.bucket = self.client.bucket(self.bucket_name)

            logger.info(
                f"[INFO] GCS client initialized | bucket={self.bucket_name} | "
                f"prefix={self.root_prefix}"
            )

        except Exception as e:
            logger.error(f"[ERROR] Failed to initialize GCS adapter : {e}")
            raise

    # Internal Helper

    def _get_blob(self, blob_name: str):
        return self.bucket.blob(blob_name)

    def _build_blob_path(self, filename: str) -> str:
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        safe_filename = Path(filename).name
        return f"{self.root_prefix}/{timestamp}/{safe_filename}"

    # Upload
    def upload_blob(
        self,
        local_file_path: str,
        filename: str
    ) -> str:
        for _ in range(3):
            try:
                blob_path = self._build_blob_path(filename)
                blob = self._get_blob(blob_path)

                with open(local_file_path, "rb") as file_data:
                    blob.upload_from_file(
                        file_data,
                        content_type="application/pdf"
                    )

                logger.info(
                    f"[INFO] Uploaded {filename} to "
                    f"gs://{self.bucket_name}/{blob_path}"
                )

                return blob.public_url

            except Exception as e:
                logger.error(
                    f"[ERROR] Upload failed for {filename} : {e}"
                )

        raise RuntimeError("GCS upload failed after retries")


    # Read
    def read_blob_from_url(self, url: str) -> bytes:
        try:
            blob_path = url.split(f"{self.bucket_name}/")[1]
            blob = self._get_blob(blob_path)
            logger.info(
                        f"[INFO] Read blob {blob_path} from bucket {self.bucket_name}"
                    )

            data=blob.download_as_bytes()
            return data
        except Exception as e:
            logger.error(
                f"[ERROR] Failed to read blob {blob_path} : {e}"
            )
            return None

    # List Blobs (Only under appian-documents)
    def list_all_blobs(self) -> List[str]:
        try:
            blobs = self.client.list_blobs(
                self.bucket_name,
                prefix=f"{self.root_prefix}/"
            )

            blob_names = [
                blob.name for blob in blobs
                if not blob.name.endswith("/")
            ]

            logger.info(
                f"[INFO] Listed blobs under prefix {self.root_prefix}"
            )
            return blob_names

        except Exception as e:
            logger.error(
                f"[ERROR] Failed to list blobs : {e}"
            )
            return []

    # Delete
    def delete_blob(self, filename: str) -> bool:
        try:
            blob_path = self._build_blob_path(filename)
            blob = self._get_blob(blob_path)
            blob.delete()

            logger.info(
                f"[INFO] Deleted blob {blob_path} from bucket {self.bucket_name}"
            )
            return True

        except Exception as e:
            logger.error(
                f"[ERROR] Failed to delete blob {filename} : {e}"
            )
            return False


gcs_blob=GCSBlob()