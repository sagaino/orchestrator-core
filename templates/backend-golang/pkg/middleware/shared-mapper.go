package middleware

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"io"
	"path/filepath"
)

type SharedMapper struct {
}

func (idem SharedMapper) GetBodyJSON(c *gin.Context) map[string]any {
	var body = map[string]any{}
	bodyRaw := c.Copy().Request.Body
	bodyByte, err := io.ReadAll(bodyRaw)
	if err != nil {

	}
	err = json.Unmarshal(bodyByte, &body)
	if err != nil {

	}

	// Restore the request body, so it can be used by Gin
	c.Request.Body = io.NopCloser(bytes.NewBuffer(bodyByte))

	return body
}

func (idem SharedMapper) GetBodyMultiPart(c *gin.Context) map[string]any {
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
