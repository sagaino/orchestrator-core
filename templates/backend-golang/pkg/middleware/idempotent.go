package middleware

import (
	"base-be-golang/pkg/cache"
	"base-be-golang/shared/payload"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type IDEMPOTENT struct {
	cache cache.DbClient
}

func NewIdempotent(
	defaultCache cache.DbClient,
) IDEMPOTENT {
	return IDEMPOTENT{
		cache: defaultCache,
	}
}

const IdempotencePrefixKey = "kassir-be:IDEMPOTENT"

func (idem IDEMPOTENT) Idempotent(name string, paramKey string, lockTime time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		// prepare the key
		key := strings.ReplaceAll(strings.ToLower(c.Param(paramKey)), " ", "")
		if key == "" {
			key = strings.ReplaceAll(strings.ToLower(c.Query(paramKey)), " ", "")
		}
		if key == "" {
			contentType := c.ContentType()
			var body map[string]any
			switch contentType {
			case gin.MIMEMultipartPOSTForm:
				body = idem.getBodyMultiPart(c)
			case gin.MIMEJSON:
				body = idem.getBodyJSON(c)
			}
			key = strings.ReplaceAll(strings.ToLower(fmt.Sprint(body[paramKey])), " ", "")

		}
		if key == "" {
			fmt.Println("IDEMPOTENT key not found")
			c.Next()
			return
		}

		ipAddress := c.ClientIP()
		// get the lock then check it
		idempotenceKey := fmt.Sprintf("%v-%v-%v-%v", IdempotencePrefixKey, ipAddress, name, key)
		ctx := context.Background()
		lock, err := idem.cache.Get(ctx, idempotenceKey)
		if err != nil {
			fmt.Println("IDEMPOTENT.go 68: ", err)
		}
		if lock != "" {
			c.JSON(http.StatusConflict, payload.DefaultErrorResponseWithMessage("IDEMPOTENT request", err))
			c.Abort()
			return
		}

		// lock request
		err = idem.cache.Set(ctx, idempotenceKey, "locked", lockTime)
		if err != nil {
			fmt.Println("IDEMPOTENT.go 79: ", err)
		}

		// handle request
		c.Next()
	}
}

func (idem IDEMPOTENT) getBodyJSON(c *gin.Context) map[string]any {
	var body = map[string]any{}
	bodyRaw := c.Copy().Request.Body
	bodyByte, err := io.ReadAll(bodyRaw)
	if err != nil {
		fmt.Println(err)
	}
	err = json.Unmarshal(bodyByte, &body)
	if err != nil {
		fmt.Println(err)
	}

	// Restore the request body so it can be used by Gin
	c.Request.Body = io.NopCloser(bytes.NewBuffer(bodyByte))

	return body
}

func (idem IDEMPOTENT) getBodyMultiPart(c *gin.Context) map[string]any {
	reqBody, err := c.MultipartForm()
	if err != nil {
		fmt.Println("c.MultipartForm: %w", err)
	}

	body := make(map[string]any)
	for key, val := range reqBody.File {
		fileName := filepath.Base(val[0].Filename)
		body[key] = fileName
	}
	for key, val := range reqBody.Value {
		body[key] = val
	}
	return body
}
