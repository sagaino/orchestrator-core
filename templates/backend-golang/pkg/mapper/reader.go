package mapper

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"strconv"
)

func (m Mapper) FloatPrecision(val float64, precision int) float64 {
	prec := fmt.Sprintf("%%.%df", precision)
	i := fmt.Sprintf(prec, val)
	f, _ := strconv.ParseFloat(i, precision)
	return f
}

func (m Mapper) Base64ToReader(base64String string) (io.Reader, int64, error) {
	// Remove data URL prefix if present (e.g., "data:image/png;base64,")
	// This handles cases where the base64 string includes the MIME type prefix
	if len(base64String) > 0 {
		// Find the comma that separates the prefix from the actual base64 data
		if commaIndex := bytes.IndexByte([]byte(base64String), ','); commaIndex != -1 {
			base64String = base64String[commaIndex+1:]
		}
	}

	// Decode the base64 string
	decodedData, err := base64.StdEncoding.DecodeString(base64String)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to decode base64: %w", err)
	}

	// Create a reader from the decoded data
	reader := bytes.NewReader(decodedData)

	return reader, int64(len(decodedData)), nil
}
