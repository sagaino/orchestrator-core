package miniostorage

import (
	"bytes"
	"context"
	"fmt"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"io"
)

type StorageMinio struct {
	client *minio.Client
	bucket string
}

type Conn struct {
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket"`
	AccessKey string `json:"access_key"`
	SecretKey string `json:"secret_key"`
}

func NewConnection(conn Conn) StorageMinio {
	client, err := minio.New(conn.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(conn.AccessKey, conn.SecretKey, ""),
		Secure: false,
	})
	if err != nil {
		panic(fmt.Errorf("connection to miniostorage err => %s", err.Error()))
	}

	return StorageMinio{client: client, bucket: conn.Bucket}
}

func (st StorageMinio) GetFile(ctx context.Context, fileName string) (*bytes.Buffer, error) {
	obj, err := st.client.GetObject(ctx, st.bucket, fileName, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}

	defer obj.Close()
	buf := new(bytes.Buffer)
	if _, err = buf.ReadFrom(obj); err != nil {
		return nil, err
	}

	return buf, nil
}

func (st StorageMinio) StoreFile(ctx context.Context, fileName string, file io.Reader, fileSize int64) (minio.UploadInfo, error) {
	uploadInfo, err := st.client.PutObject(ctx, st.bucket, fileName, file, fileSize, minio.PutObjectOptions{})
	if err != nil {
		return minio.UploadInfo{}, err
	}

	return uploadInfo, nil
}

func (st StorageMinio) DeleteFile(ctx context.Context, fileName string) error {
	return st.client.RemoveObject(ctx, st.bucket, fileName, minio.RemoveObjectOptions{})
}
